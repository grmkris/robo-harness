import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { type Harness, startHarness, tokens } from "./harness";

const root = join(import.meta.dir, "../../..");
const operator = tokens.operator;
const agentToken = tokens.agent;
const workerToken = tokens.worker;
let h: Harness;
let base: string;
let request: Harness["request"];
let call: Harness["call"];
let until: Harness["until"];
let requests: Record<string, unknown>[];

beforeAll(async () => {
  h = await startHarness();
  base = h.base;
  request = h.request;
  call = h.call;
  until = h.until;
  requests = h.requests;
}, 30_000);
afterAll(async () => {
  await h.close();
});

describe("mock HTTP integration", () => {
  test("requires authentication and rejects cross-origin control", async () => {
    expect((await request("/api/status", undefined, "incorrect")).status).toBe(
      401
    );
    expect(
      (
        await request("/api/tool/stop", {}, operator, {
          Origin: "https://untrusted.example",
        })
      ).status
    ).toBe(403);
    expect(
      (
        await request("/api/login", { token: operator }, operator, {
          Origin: base,
        })
      ).status
    ).toBe(200);
    // A rebound hostname matches its own Host-derived origin; only the allowlist may decide.
    expect(
      (
        await request("/api/tool/stop", {}, operator, {
          Host: `rebound.example:${h.port}`,
          Origin: `http://rebound.example:${h.port}`,
        })
      ).status
    ).toBe(403);
  });
  test("malformed credentials and prototype names are refused, not crashed", async () => {
    expect((await request("/api/status", undefined, "ü")).status).toBe(401);
    expect(
      (await request("/api/login", { token: "üü" }, "ü", { Origin: base }))
        .status
    ).toBe(401);
    expect((await call("constructor")).status).toBe(404);
    expect((await call("__proto__")).status).toBe(404);
  });
  test("agents cannot impersonate humans or increase compute budgets", async () => {
    expect(
      (await call("acquire", { mode: "human", takeover: true }, agentToken))
        .status
    ).toBe(403);
    expect(
      (await request("/api/budget", { limit: 10 }, agentToken)).status
    ).toBe(403);
  });
  test("bounded move, idempotency, measured completion and takeover", async () => {
    await call("stop");
    expect((await call("acquire", { mode: "agent" }, agentToken)).status).toBe(
      200
    );
    const obs = (await call("observe", {}, agentToken)).data;
    const wild = await call(
      "move",
      { request_id: crypto.randomUUID(), target: { shoulder_pan: 10_000 } },
      agentToken
    );
    expect(wild.status).toBe(422);
    expect(wild.data.error).toContain("shoulder_pan");
    const body = {
      request_id: crypto.randomUUID(),
      target: { gripper: obs.measured.gripper + 2 },
      duration_s: 0.5,
    };
    const first = await call("move", body, agentToken);
    expect(first.status).toBe(200);
    expect(first.data.status).toBe("accepted");
    expect((await call("move", body, agentToken)).data.id).toBe(first.data.id);
    await until(
      async () =>
        (await call("operation", { id: first.data.id })).data.status ===
        "completed"
    );
    const next = await call(
      "move",
      {
        request_id: crypto.randomUUID(),
        target: { shoulder_pan: 2 },
        duration_s: 2,
      },
      agentToken
    );
    expect(
      (await call("acquire", { mode: "human", takeover: true })).status
    ).toBe(200);
    expect((await call("operation", { id: next.data.id })).data.status).toBe(
      "cancelled"
    );
    expect((await call("renew", {}, agentToken)).status).toBe(409);
    await call("release");
  });
  test("stop cancels a running move, revokes control and allows a fresh acquire", async () => {
    expect((await call("acquire", { mode: "agent" }, agentToken)).status).toBe(
      200
    );
    const running = await call(
      "move",
      {
        request_id: crypto.randomUUID(),
        target: { shoulder_pan: -3 },
        duration_s: 3,
      },
      agentToken
    );
    expect(running.status).toBe(200);
    expect((await call("stop")).status).toBe(200);
    expect((await call("operation", { id: running.data.id })).data.status).toBe(
      "cancelled"
    );
    // observe reports the last 100 ms sample, which may predate the stop.
    await until(async () => (await call("observe")).data.operator === null);
    expect((await call("renew", {}, agentToken)).status).toBe(409);
    expect((await call("acquire", { mode: "agent" }, agentToken)).status).toBe(
      200
    );
    await call("release", {}, agentToken);
  });
  test("lease expiry cancels continued motion", async () => {
    await call("acquire", { mode: "agent" }, agentToken);
    const result = await call(
      "move",
      {
        request_id: crypto.randomUUID(),
        target: { shoulder_pan: 5 },
        duration_s: 5,
      },
      agentToken
    );
    await until(
      async () =>
        (await call("operation", { id: result.data.id })).data.status ===
        "cancelled",
      5000
    );
    // The operator clears a sample after the operation cancels; wait for it.
    await until(async () => (await call("observe")).data.operator === null);
    const late = await call(
      "move",
      { request_id: crypto.randomUUID(), target: { shoulder_pan: 1 } },
      agentToken
    );
    expect(late.status).toBe(409);
    expect(late.data.error).toContain("expired");
  }, 7000);
  test("capture returns image provenance and no paid inference is implicit", async () => {
    const frame = await call("capture", { camera: "workspace" });
    expect(frame.data.media_type).toBe("image/jpeg");
    expect(frame.data.id).toContain("workspace");
    expect(Buffer.from(frame.data.base64, "base64").length).toBeGreaterThan(
      100
    );
    expect(
      (await call("perceive", { camera: "workspace", kind: "depth" })).status
    ).toBe(402);
  });
  test("perception budgets are enforced atomically and wrong frames are rejected", async () => {
    expect((await request("/api/budget", { limit: 0.02 })).status).toBe(200);
    const spent = async () =>
      ((await (await request("/api/status")).json()) as any).budget.spent_usd;
    const down = await call("perceive", {
      camera: "workspace",
      kind: "depth",
      prompt: "fail",
    });
    expect(down.status).toBe(502);
    expect(await spent()).toBe(0);
    const result = await call("perceive", {
      camera: "workspace",
      kind: "depth",
    });
    expect(result.status).toBe(200);
    expect(result.data.frame_id).toContain("workspace");
    const bad = await call("perceive", {
      camera: "workspace",
      kind: "depth",
      prompt: "wrong frame",
    });
    expect(bad.status).toBe(502);
    expect(bad.data.error).toContain("source frame");
    expect(await spent()).toBeCloseTo(0.02, 6);
    expect(
      (await call("perceive", { camera: "workspace", kind: "depth" })).status
    ).toBe(402);
    expect((await request("/api/budget", { limit: 0.001 })).status).toBe(409);
  });
  test("recording captures camera/action evidence and finalizes", async () => {
    const started = await call("recording_start", { label: "integration" });
    expect(started.status).toBe(200);
    expect((await call("recording_start", { label: "duplicate" })).status).toBe(
      409
    );
    await until(async () => ((await h.status()).recording?.frames ?? 0) >= 3);
    const stopped = await call("recording_stop");
    expect(stopped.data.frames).toBeGreaterThan(2);
    // "captured" when every sample met its deadline; a missed deadline under
    // load is a legitimate "incomplete", so both are accepted.
    expect(["captured", "incomplete"]).toContain(stopped.data.state);
    const manifest = JSON.parse(
      await readFile(`${stopped.data.path}/manifest.json`, "utf-8")
    );
    expect(manifest.backend).toBe("mock");
    expect(manifest.urdf_sha256).toHaveLength(64);
    const lines = (
      await readFile(`${stopped.data.path}/samples.jsonl`, "utf-8")
    )
      .trim()
      .split("\n");
    expect(lines.length).toBe(stopped.data.frames);
    expect(JSON.parse(lines[0] ?? "{}").images.workspace.path).toStartWith(
      "images/"
    );
    // Events raised right after the stop must not reach a recording that is gone.
    await call("acquire", { mode: "agent" }, agentToken);
    await call("release", {}, agentToken);
    const events = (
      await readFile(`${stopped.data.path}/events.jsonl`, "utf-8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((e) => e.type)).toContain("recording.started");
    expect(events.map((e) => e.type)).not.toContain("control.acquired");
    expect((await request("/api/status")).status).toBe(200);
  });
  test("custom model loop executes observation and image tools", async () => {
    requests.length = 0;
    const response = await request("/api/chat", {
      provider: "alibaba",
      text: "Inspect the camera without moving.",
    });
    const session = (await response.json()) as { session_id: string };
    expect(response.status).toBe(200);
    await until(async () => {
      const s = (await (await request("/api/status")).json()) as any;
      return !s.running.includes(session.session_id);
    });
    expect(requests.length).toBeGreaterThan(1);
    expect(JSON.stringify(requests).includes("image_url")).toBe(true);
    const history = (await (await request("/api/conversations")).json()) as {
      id: string;
    }[];
    expect(history.some((c) => c.id === session.session_id)).toBe(true);
    // The model saw the image (image_url above), but the stored transcript must
    // not carry the base64 payload.
    const convo = await (
      await request(`/api/conversations/${session.session_id}`)
    ).json();
    expect(JSON.stringify(convo).includes("base64,")).toBe(false);
  });
  test("a malformed event cursor replays from the beginning", async () => {
    const page = async (after: string) =>
      (await (
        await request(`/api/telemetry?after=${after}`, undefined, workerToken)
      ).json()) as { events: { id: number }[] };
    expect((await page("abc")).events.length).toBeGreaterThan(0);
    expect((await page("abc")).events[0]?.id).toBe(
      (await page("0")).events[0]?.id
    );
    expect((await page("999999999")).events.length).toBe(0);
  });
  test("MCP serves the same observation and image capabilities", async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: [`${root}/apps/cli/src/mcp.ts`],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (p): p is [string, string] => typeof p[1] === "string"
          )
        ),
        ROBO_URL: base,
        ROBO_TOKEN: agentToken,
        ROBO_CONTROLLER: "mcp-test",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "robo-integration", version: "1" });
    try {
      await client.connect(transport);
      expect(
        (await client.listTools()).tools.some((t) => t.name === "robot_move")
      ).toBe(true);
      const result = await client.callTool({
        name: "robot_capture",
        arguments: { camera: "wrist" },
      });
      expect(
        (result.content as { type: string }[]).some((c) => c.type === "image")
      ).toBe(true);
    } finally {
      await client.close();
    }
  }, 10_000);
});
