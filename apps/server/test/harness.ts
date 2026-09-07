import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");

export const tokens = {
  operator: "integration-operator-token-not-a-real-secret",
  agent: "integration-agent-token-not-a-real-secret",
  io: "integration-io-token-not-a-real-secret",
  worker: "integration-worker-token-not-a-real-secret",
};

/** Read a subprocess's stdout until it announces its resolved port. */
async function announcedPort(
  proc: ReturnType<typeof Bun.spawn>,
  label: string
): Promise<number> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as { event?: string; port?: number };
        if (event.event === "listening" && typeof event.port === "number") {
          reader.releaseLock();
          // Drain the rest so the pipe never fills and blocks the child.
          void drain(proc);
          return event.port;
        }
      } catch {
        // Non-JSON startup noise; keep reading.
      }
    }
  }
  reader.releaseLock();
  throw new Error(`${label} never announced a listening port`);
}

async function drain(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        return;
      }
    }
  } catch {
    // Process ended.
  }
}

export interface Harness {
  readonly base: string;
  readonly port: number;
  readonly requests: Record<string, unknown>[];
  readonly request: (
    path: string,
    body?: unknown,
    token?: string,
    headers?: Record<string, string>
  ) => Promise<Response>;
  readonly call: (
    name: string,
    body?: unknown,
    token?: string
  ) => Promise<{ status: number; data: any }>;
  readonly status: () => Promise<any>;
  readonly until: (
    check: () => Promise<boolean>,
    timeout?: number
  ) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface HarnessOptions {
  /** "token" (default) or "tailnet". */
  readonly accessMode?: "token" | "tailnet";
  /** Start the Python mock I/O service (default true). */
  readonly withIo?: boolean;
  /** Start the model/perception fixture (default true). */
  readonly withFixture?: boolean;
  /** Point the app at this I/O URL instead of a started service. */
  readonly ioUrl?: string;
  /** Extra environment for the app process. */
  readonly env?: Record<string, string>;
}

export async function startHarness(
  options: HarnessOptions = {}
): Promise<Harness> {
  const accessMode = options.accessMode ?? "token";
  const withIo = options.withIo ?? true;
  const withFixture = options.withFixture ?? true;
  const directory = await mkdtemp(join(tmpdir(), "robo-harness-"));
  const requests: Record<string, unknown>[] = [];

  const fixture = withFixture ? startFixture(requests) : undefined;

  let io: ReturnType<typeof Bun.spawn> | undefined;
  let ioUrl = options.ioUrl ?? "http://127.0.0.1:59999";
  if (withIo) {
    io = Bun.spawn(
      [`${root}/.venv/bin/python`, "-m", "robo_harness.service", "--port", "0"],
      {
        cwd: root,
        env: { ...process.env, ROBO_IO_TOKEN: tokens.io },
        stdout: "pipe",
        stderr: "ignore",
      }
    );
    ioUrl = `http://127.0.0.1:${await announcedPort(io, "io")}`;
  }

  const app = Bun.spawn(["bun", "apps/server/src/main.ts"], {
    cwd: root,
    env: {
      ...process.env,
      ROBO_PORT: "0",
      ROBO_HOST: "127.0.0.1",
      ROBO_ACCESS_MODE: accessMode,
      ROBO_TRUST_LOOPBACK: "1",
      ROBO_DATA_DIR: directory,
      ROBO_TOKEN: tokens.operator,
      ROBO_AGENT_TOKEN: tokens.agent,
      ROBO_IO_TOKEN: tokens.io,
      ROBO_WORKER_TOKEN: tokens.worker,
      ROBO_IO_URL: ioUrl,
      DASHSCOPE_API_KEY: "fixture-key-not-real",
      ROBO_ALIBABA_MODEL: "fixture",
      ROBO_ALIBABA_VISION: "1",
      ROBO_PERCEPTION_TOKEN: "local-fixture-token",
      ROBO_PERCEPTION_COST_USD: "0.01",
      ...(fixture
        ? {
            ROBO_ALIBABA_URL: `http://127.0.0.1:${fixture.port}`,
            ROBO_PERCEPTION_URL: `http://127.0.0.1:${fixture.port}`,
          }
        : {}),
      ...options.env,
    },
    stdout: "pipe",
    stderr: "ignore",
  });
  const port = await announcedPort(app, "app");
  const base = `http://127.0.0.1:${port}`;

  const request = (
    path: string,
    body?: unknown,
    token = tokens.operator,
    headers: Record<string, string> = {}
  ): Promise<Response> =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? null : JSON.stringify(body),
    });

  const call = async (
    name: string,
    body: unknown = {},
    token = tokens.operator
  ): Promise<{ status: number; data: any }> => {
    const response = await request(`/api/tool/${name}`, body, token);
    return { status: response.status, data: await response.json() };
  };

  const status = async (): Promise<any> =>
    (await request("/api/status")).json();

  const until = async (
    check: () => Promise<boolean>,
    timeout = 8000
  ): Promise<void> => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await check()) {
        return;
      }
      await Bun.sleep(60);
    }
    throw new Error("Condition timed out");
  };

  await until(async () => {
    try {
      const s = await status();
      return withIo
        ? s.observation?.backend === "mock" && !s.robot_error
        : true;
    } catch {
      return false;
    }
  }, 15_000);

  const close = async (): Promise<void> => {
    app.kill("SIGTERM");
    io?.kill("SIGTERM");
    fixture?.stop(true);
    await Promise.race([
      Promise.all([app.exited, io?.exited].filter(Boolean)),
      Bun.sleep(5000),
    ]);
    await rm(directory, { recursive: true, force: true });
  };

  return { base, port, requests, request, call, status, until, close };
}

function startFixture(
  requests: Record<string, unknown>[]
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/infer") {
        const payload = (await req.json()) as {
          kind: string;
          prompt: string;
          frame: { id: string; width: number; height: number };
        };
        if (payload.prompt === "fail") {
          return new Response("worker down", { status: 500 });
        }
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
        messages: { role: string; content: unknown }[];
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
        `${chunks
          .map((c) => `data: ${JSON.stringify(c)}\n\n`)
          .join("")}data: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } }
      );
    },
  });
}
