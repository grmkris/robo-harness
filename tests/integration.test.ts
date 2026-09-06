import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = join(import.meta.dir, "..");
const appPort = 18940,
  ioPort = 18941;
const operator = "integration-operator-token-not-a-real-secret";
const agentToken = "integration-agent-token-not-a-real-secret";
const ioToken = "integration-io-token-not-a-real-secret";
let directory = "",
  app: ReturnType<typeof Bun.spawn>,
  io: ReturnType<typeof Bun.spawn>,
  fixture: ReturnType<typeof Bun.serve>;
let requests: Record<string, unknown>[] = [];
const base = "http://127.0.0.1:" + appPort;
async function request(
  path: string,
  body?: unknown,
  token = operator,
  headers: Record<string, string> = {},
) {
  return fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function call(name: string, body: unknown = {}, token = operator) {
  const response = await request("/api/tool/" + name, body, token);
  return {
    status: response.status,
    data: (await response.json()) as Record<string, any>,
  };
}
async function until(check: () => Promise<boolean>, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(80);
  }
  throw new Error("Condition timed out");
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "robo-integration-"));
  fixture = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/infer") {
        const payload = (await req.json()) as {
          kind: string;
          prompt: string;
          frame: { id: string; width: number; height: number };
        };
        return Response.json({
          kind: payload.kind,
          model: "local-test-fixture",
          model_version: "1",
          frame_id:
            payload.prompt === "wrong frame" ? "mismatched" : payload.frame.id,
          width: payload.frame.width,
          height: payload.frame.height,
          preview_png:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
          units: "relative",
          depth: [[1]],
        });
      }
      const body = (await req.json()) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      requests.push(body);
      const done = body.messages.some((m) => m.role === "tool");
      const capture = JSON.stringify(body.messages).includes("camera");
      const delta = done
        ? { content: "Verified mock observation. No movement executed." }
        : {
            tool_calls: [
              {
                index: 0,
                id: "fixture-call",
                type: "function",
                function: {
                  name: capture ? "capture" : "observe",
                  arguments: capture ? '{"camera":"workspace"}' : "{}",
                },
              },
            ],
          };
      const chunks = [
        {
          id: "fixture",
          object: "chat.completion.chunk",
          created: 0,
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason: null }],
        },
        {
          id: "fixture",
          object: "chat.completion.chunk",
          created: 0,
          model: "fixture",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: done ? "stop" : "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        },
      ];
      return new Response(
        chunks.map((c) => "data: " + JSON.stringify(c) + "\n\n").join("") +
          "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  io = Bun.spawn(
    [
      root + "/.venv/bin/python",
      "-m",
      "robo_harness.service",
      "--port",
      String(ioPort),
    ],
    {
      cwd: root,
      env: { ...process.env, ROBO_IO_TOKEN: ioToken },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  app = Bun.spawn(["bun", "src/server/main.ts"], {
    cwd: root,
    env: {
      ...process.env,
      ROBO_PORT: String(appPort),
      ROBO_HOST: "127.0.0.1",
      ROBO_ACCESS_MODE: "token",
      ROBO_DATA_DIR: directory,
      ROBO_TOKEN: operator,
      ROBO_AGENT_TOKEN: agentToken,
      ROBO_IO_TOKEN: ioToken,
      ROBO_IO_URL: "http://127.0.0.1:" + ioPort,
      DASHSCOPE_API_KEY: "fixture-key-not-real",
      ROBO_ALIBABA_URL: "http://127.0.0.1:" + fixture.port,
      ROBO_ALIBABA_MODEL: "fixture",
      ROBO_ALIBABA_VISION: "1",
      ROBO_PERCEPTION_URL: "http://127.0.0.1:" + fixture.port,
      ROBO_PERCEPTION_TOKEN: "local-fixture-token",
      ROBO_PERCEPTION_COST_USD: "0.01",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  await until(async () => {
    try {
      const res = await request("/api/status");
      const s = (await res.json()) as any;
      return s.observation?.backend === "mock" && !s.robot_error;
    } catch {
      return false;
    }
  }, 12000);
}, 15000);
afterAll(async () => {
  app?.kill("SIGTERM");
  io?.kill("SIGTERM");
  fixture?.stop(true);
  await Promise.all([app?.exited, io?.exited]);
  if (directory) await rm(directory, { recursive: true, force: true });
});
describe("mock HTTP integration", () => {
  test("requires authentication and rejects cross-origin control", async () => {
    expect((await request("/api/status", undefined, "incorrect")).status).toBe(
      401,
    );
    expect(
      (
        await request("/api/tool/stop", {}, operator, {
          Origin: "https://untrusted.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/login", { token: operator }, operator, {
          Origin: base,
        })
      ).status,
    ).toBe(200);
    // A rebound hostname matches its own Host-derived origin; only the allowlist may decide.
    expect(
      (
        await request("/api/tool/stop", {}, operator, {
          Host: "rebound.example:" + appPort,
          Origin: "http://rebound.example:" + appPort,
        })
      ).status,
    ).toBe(403);
  });
  test("malformed credentials and prototype names are refused, not crashed", async () => {
    expect((await request("/api/status", undefined, "ü")).status).toBe(401);
    expect(
      (await request("/api/login", { token: "üü" }, "ü", { Origin: base }))
        .status,
    ).toBe(401);
    expect((await call("constructor")).status).toBe(404);
    expect((await call("__proto__")).status).toBe(404);
  });
  test("agents cannot impersonate humans or increase compute budgets", async () => {
    expect(
      (await call("acquire", { mode: "human", takeover: true }, agentToken))
        .status,
    ).toBe(403);
    expect(
      (await request("/api/budget", { limit: 10 }, agentToken)).status,
    ).toBe(403);
  });
  test("bounded move, idempotency, measured completion and takeover", async () => {
    await call("stop");
    expect((await call("acquire", { mode: "agent" }, agentToken)).status).toBe(
      200,
    );
    const obs = (await call("observe", {}, agentToken)).data;
    const wild = await call(
      "move",
      { request_id: crypto.randomUUID(), target: { shoulder_pan: 10000 } },
      agentToken,
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
        "completed",
    );
    const next = await call(
      "move",
      {
        request_id: crypto.randomUUID(),
        target: { shoulder_pan: 2 },
        duration_s: 2,
      },
      agentToken,
    );
    expect(
      (await call("acquire", { mode: "human", takeover: true })).status,
    ).toBe(200);
    expect((await call("operation", { id: next.data.id })).data.status).toBe(
      "cancelled",
    );
    expect((await call("renew", {}, agentToken)).status).toBe(409);
    await call("release");
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
      agentToken,
    );
    await until(
      async () =>
        (await call("operation", { id: result.data.id })).data.status ===
        "cancelled",
      5000,
    );
    expect((await call("observe")).data.operator).toBeNull();
    const late = await call(
      "move",
      { request_id: crypto.randomUUID(), target: { shoulder_pan: 1 } },
      agentToken,
    );
    expect(late.status).toBe(409);
    expect(late.data.error).toContain("expired");
  }, 7000);
  test("capture returns image provenance and no paid inference is implicit", async () => {
    const frame = await call("capture", { camera: "workspace" });
    expect(frame.data.media_type).toBe("image/jpeg");
    expect(frame.data.id).toContain("workspace");
    expect(Buffer.from(frame.data.base64, "base64").length).toBeGreaterThan(
      100,
    );
    expect(
      (await call("perceive", { camera: "workspace", kind: "depth" })).status,
    ).toBe(402);
  });
  test("perception budgets are enforced atomically and wrong frames are rejected", async () => {
    expect((await request("/api/budget", { limit: 0.02 })).status).toBe(200);
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
    expect(
      (await call("perceive", { camera: "workspace", kind: "depth" })).status,
    ).toBe(402);
    expect((await request("/api/budget", { limit: 0.001 })).status).toBe(409);
  });
  test("recording captures camera/action evidence and finalizes", async () => {
    const started = await call("recording_start", { label: "integration" });
    expect(started.status).toBe(200);
    expect((await call("recording_start", { label: "duplicate" })).status).toBe(
      409,
    );
    await Bun.sleep(700);
    const stopped = await call("recording_stop");
    expect(stopped.data.frames).toBeGreaterThan(2);
    expect(stopped.data.state).toBe("captured");
    const manifest = JSON.parse(
      await readFile(stopped.data.path + "/manifest.json", "utf8"),
    );
    expect(manifest.backend).toBe("mock");
    expect(manifest.urdf_sha256).toHaveLength(64);
    const lines = (await readFile(stopped.data.path + "/samples.jsonl", "utf8"))
      .trim()
      .split("\n");
    expect(lines.length).toBe(stopped.data.frames);
    expect(JSON.parse(lines[0]).images.workspace.path).toStartWith("images/");
  });
  test("custom model loop executes observation and image tools", async () => {
    requests = [];
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
    const history = (await (
      await request("/api/conversations")
    ).json()) as Array<{ id: string }>;
    expect(history.some((c) => c.id === session.session_id)).toBe(true);
  });
  test("MCP serves the same observation and image capabilities", async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: [root + "/src/mcp.ts"],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (p): p is [string, string] => typeof p[1] === "string",
          ),
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
        (await client.listTools()).tools.some((t) => t.name === "robot_move"),
      ).toBe(true);
      const result = await client.callTool({
        name: "robot_capture",
        arguments: { camera: "wrist" },
      });
      expect(
        (result.content as Array<{ type: string }>).some(
          (c) => c.type === "image",
        ),
      ).toBe(true);
    } finally {
      await client.close();
    }
  }, 10000);
});
