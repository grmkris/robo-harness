import { mkdir, writeFile } from "node:fs/promises";

/** Explicit hardware acceptance: default observes; --move opens gripper <=2 percentage points. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const url = process.env["ROBO_URL"] ?? "http://100.105.51.45:8940";
const folder = root + "/var/real-arm-acceptance";
await mkdir(folder, { recursive: true });
const client = new Client({ name: "real-arm-acceptance", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "bun",
  args: [root + "/src/mcp.ts"],
  cwd: root,
  env: {
    PATH: process.env["PATH"]!,
    ROBO_URL: url,
    ROBO_CONTROLLER: "commissioning-agent",
  },
  stderr: "inherit",
});
// Evidence is assembled ad hoc from tool replies; the CLI rewrite types it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const evidence: any = { started_ms: Date.now(), url };
let recording = false;
let acquired = false;
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({
    name: "robot_" + name,
    arguments: args,
  });
  const content = result.content as Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  const text = content.find((c) => c.type === "text")?.text;
  if (result.isError) throw new Error(text ?? "MCP tool failed");
  return { data: JSON.parse(text ?? "{}"), content };
}
try {
  await client.connect(transport);
  evidence.tools = (await client.listTools()).tools.map((t) => t.name);
  evidence.before = (await call("observe")).data;
  if (evidence.before.backend !== "so101" || evidence.before.fault)
    throw new Error("Requires a healthy real SO-101 backend");
  evidence.frames = {};
  for (const camera of ["workspace", "wrist"]) {
    const frame = await call("capture", { camera });
    const image = frame.content.find((c) => c.type === "image");
    if (
      !image?.data ||
      frame.data.age_ms > 500 ||
      frame.data.clock_domain !== evidence.before.clock_domain
    )
      throw new Error(
        "A fresh MCP image with matching robot clock domain is required"
      );
    await writeFile(
      folder + "/" + camera + ".jpg",
      Buffer.from(image.data, "base64")
    );
    evidence.frames[camera] = frame.data;
  }
  if (process.argv.includes("--move")) {
    const initial = evidence.before.measured.gripper;
    const target = initial + 2;
    if (target > evidence.before.limits.gripper[1])
      throw new Error("Gripper lacks two points of opening room");
    evidence.recording = (
      await call("recording_start", {
        label: "Real SO-101 · MCP gripper +2 · measured stop",
      })
    ).data;
    recording = true;
    await Bun.sleep(1200);
    evidence.lease = (
      await call("acquire", { mode: "agent", takeover: false })
    ).data;
    acquired = true;
    let op = (
      await call("move", {
        request_id: crypto.randomUUID(),
        target: { gripper: target },
        duration_s: 1.5,
      })
    ).data;
    const deadline = Date.now() + 6500;
    while (["accepted", "running"].includes(op.status)) {
      if (Date.now() > deadline) throw new Error("Motion acceptance timed out");
      await call("renew");
      await Bun.sleep(120);
      op = (await call("operation", { id: op.id })).data;
    }
    evidence.operation = op;
    if (op.status !== "completed")
      throw new Error("Motion " + op.status + ": " + op.reason);
    await Bun.sleep(250);
    evidence.after = (await call("observe")).data;
    evidence.measured_delta = evidence.after.measured.gripper - initial;
    if (evidence.measured_delta < 0.2 || evidence.measured_delta > 2.5)
      throw new Error(
        "Measured gripper movement did not match the tiny opening test"
      );
    for (const joint of Object.keys(evidence.before.measured).filter(
      (j) => j !== "gripper"
    ))
      if (
        Math.abs(
          evidence.after.measured[joint] - evidence.before.measured[joint]
        ) > 0.8
      )
        throw new Error("Unexpected drift in " + joint);
    evidence.stopped = (await call("stop")).data;
    acquired = false;
    if (evidence.stopped.operator !== null)
      throw new Error("Stop did not revoke controller");
    await Bun.sleep(1000);
    evidence.held = (await call("observe")).data;
    if (
      JSON.stringify(evidence.held.commanded) !==
      JSON.stringify(evidence.stopped.commanded)
    )
      throw new Error("Commanded pose changed after stop");
    evidence.recording = (await call("recording_stop")).data;
    recording = false;
    await Bun.sleep(1000);
    const replay = await fetch(
      url + "/api/recordings/" + evidence.recording.id + "/replay.rrd"
    );
    if (!replay.ok) throw new Error("Rerun replay is unavailable");
    evidence.replay_bytes = (await replay.arrayBuffer()).byteLength;
    if (evidence.replay_bytes < 10000)
      throw new Error("Rerun replay is unexpectedly small");
  }
  evidence.result = "passed";
} catch (e) {
  evidence.error = e instanceof Error ? e.message : String(e);
  throw e;
} finally {
  if (acquired) await call("stop").catch(() => {});
  if (recording)
    evidence.recording = (
      await call("recording_stop").catch(() => ({ data: null }))
    ).data;
  evidence.finished_ms = Date.now();
  await writeFile(
    folder +
      (process.argv.includes("--move") ? "/motion.json" : "/observation.json"),
    JSON.stringify(evidence, null, 2)
  );
  await client.close();
  console.log(
    JSON.stringify({
      result: evidence.result,
      error: evidence.error,
      backend: evidence.before?.backend,
      cameras: evidence.frames,
      operation: evidence.operation,
      measured_delta: evidence.measured_delta,
      recording: evidence.recording,
      replay_bytes: evidence.replay_bytes,
      folder,
    })
  );
}
