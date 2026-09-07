import { resolve, sep } from "node:path";

import { toolSchemas } from "@robo/protocol";
import type { ToolName } from "@robo/protocol";
import { z } from "zod";

import { equal, parseCursor, trustedSource } from "./access";
import * as agent from "./agent";
import { getCapability, sweepCapabilities } from "./capabilities";
import { config } from "./config";
import { budget, setBudget, perceptionConfig } from "./perception";
import { catalog } from "./providers";
import * as recording from "./recordings";
import * as robot from "./robot";
import { db, events, subscribe } from "./store";
import { executeTool } from "./tools";
import type { Principal } from "./tools";

const sessions = new Map<string, { owner: string; expires: number }>();
let telemetry = {
  at: 0,
  error: "Telemetry worker has not connected" as string | null,
  dropped: 0,
  version: "",
  recording_id: null as string | null,
};
const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(body, headers ? { status, headers } : { status });
const auth = (req: Request): Principal | null => {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (bearer) {
    const capability = getCapability(bearer);
    if (capability) {
      return capability;
    }
  }
  if (bearer && equal(bearer, config.token)) {
    return { owner: "operator-cli", human: true };
  }
  if (bearer && equal(bearer, config.agentToken)) {
    const key = req.headers.get("x-robo-controller") ?? "cli";
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(key)) {
      return null;
    }
    return { owner: `external-${key}`, human: false };
  }
  const cookie = req.headers
    .get("cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("robo_session="))
    ?.slice(13);
  const session = cookie ? sessions.get(cookie) : undefined;
  if (session && session.expires > Date.now()) {
    return { owner: session.owner, human: true };
  }
  // An expired program credential must not fall back to operator access.
  if (bearer || config.accessMode !== "tailnet") {
    return null;
  }
  // Tailnet trust comes from the source address, never from a header. The
  // identity headers only choose a name; they cannot grant human privilege.
  const address = server.requestIP(req)?.address ?? "";
  if (!trustedSource(address, config.trust)) {
    return null;
  }
  const browser = req.headers.get("x-robo-browser");
  const controller = req.headers.get("x-robo-controller");
  const id = browser ?? controller;
  if (id && !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
    return null;
  }
  if (browser) {
    return { owner: "browser-" + browser, human: true };
  }
  if (controller) {
    return { owner: "external-" + controller, human: false };
  }
  return { owner: `tailnet-${address}`, human: true };
};
const isWorker = (req: Request) =>
  equal(req.headers.get("authorization") ?? "", `Bearer ${config.workerToken}`);
const parse = async (req: Request) => {
  const text = await req.text();
  if (text.length > 65_536) {
    throw new robot.ApiError("Request too large", 413);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new robot.ApiError("Malformed JSON", 400);
  }
};
const requireHuman = (p: Principal) => {
  if (!p.human) {
    throw new robot.ApiError("Human operator authorization required", 403);
  }
};
const status = async () => ({
  access_mode: config.accessMode,
  observation: robot.current,
  robot_error: robot.robotError,
  received_at: robot.receivedAt,
  clock: robot.clock,
  providers: await catalog(),
  running: agent.running(),
  conversations: agent.conversations(),
  recording: recording.active,
  telemetry: { ...telemetry, online: Date.now() - telemetry.at < 3000 },
  perception: perceptionConfig(),
  budget: budget(),
});
const failedLogins = new Map<string, { count: number; until: number }>();
// Login sessions, throttle records and program capabilities are keyed by
// untrusted input, so without a sweep each one grows for the life of the process.
export function sweep(now = Date.now()) {
  for (const [key, value] of sessions) {
    if (value.expires <= now) sessions.delete(key);
  }
  for (const [key, value] of failedLogins) {
    if (value.until <= now) failedLogins.delete(key);
  }
  sweepCapabilities(now);
}
const sweeper = setInterval(sweep, 60_000);
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!["GET", "HEAD"].includes(req.method)) {
    const origin = req.headers.get("origin");
    if (origin && !config.allowedOrigins.has(origin)) {
      return json({ error: "Origin mismatch" }, 403);
    }
  }
  if (path === "/api/login" && req.method === "POST") {
    const key = server.requestIP(req)?.address ?? "unknown";
    const attempts = failedLogins.get(key);
    if (attempts && attempts.until > Date.now() && attempts.count >= 10) {
      return json({ error: "Too many attempts; retry in a minute" }, 429);
    }
    const body = z
      .object({ token: z.string().max(200) })
      .parse(await parse(req));
    if (!equal(body.token, config.token)) {
      failedLogins.set(key, {
        count:
          (attempts?.until ?? 0) > Date.now() ? (attempts?.count ?? 0) + 1 : 1,
        until: Date.now() + 60_000,
      });
      return json({ error: "Incorrect operator token" }, 401);
    }
    failedLogins.delete(key);
    const id = crypto.randomUUID();
    sessions.set(id, {
      owner: `browser-${id}`,
      expires: Date.now() + 12 * 3_600_000,
    });
    return json({ authenticated: true }, 200, {
      "Set-Cookie": `robo_session=${
        id
      }; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${
        url.protocol === "https:" ? "; Secure" : ""
      }`,
    });
  }
  if (path.startsWith("/api/telemetry")) {
    if (!isWorker(req)) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (path === "/api/telemetry/heartbeat" && req.method === "POST") {
      const body = z
        .object({
          error: z.string().nullable(),
          dropped: z.number().int().nonnegative(),
          version: z.string(),
          recording_id: z.string().nullable(),
        })
        .parse(await parse(req));
      telemetry = { ...body, at: Date.now() };
      return json({ ok: true });
    }
    const results = db
      .query(
        "SELECT id,result FROM perception WHERE state='completed' ORDER BY created DESC LIMIT 8"
      )
      .all() as { id: string; result: string }[];
    return json({
      observation: robot.current,
      received_at: robot.receivedAt,
      frames: robot.currentFrames,
      clock: robot.clock,
      events: events(parseCursor(url.searchParams.get("after")), 200),
      recording: recording.active,
      perception: results.map((r) => ({ id: r.id, ...JSON.parse(r.result) })),
    });
  }
  const principal = auth(req);
  if (
    path.startsWith("/api/") ||
    path.startsWith("/rerun/") ||
    path.startsWith("/rerun.") ||
    path === "/proxy"
  ) {
    if (!principal) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (path === "/api/status") {
      return json({ ...(await status()), controller: principal.owner });
    }
    if (path === "/api/logout" && req.method === "POST") {
      await robot.release(principal.owner).catch(() => {});
      for (const [key, value] of sessions) {
        if (value.owner === principal.owner) sessions.delete(key);
      }
      return json({ ok: true }, 200, {
        "Set-Cookie":
          "robo_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      });
    }
    if (path === "/api/events") {
      let cleanup = () => {};
      const stream = new ReadableStream({
        start(controller) {
          const send = (value: unknown) => {
            try {
              if ((controller.desiredSize ?? 0) < -100) {
                cleanup();
                controller.close();
                return;
              }
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
              );
            } catch {
              cleanup();
            }
          };
          const after = parseCursor(
            req.headers.get("last-event-id") ?? url.searchParams.get("after")
          );
          for (const event of events(after)) {
            send(event);
          }
          const off = subscribe(send);
          const timer = setInterval(() => {
            try {
              controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
            } catch {
              cleanup();
            }
          }, 15_000);
          cleanup = () => {
            off();
            clearInterval(timer);
          };
          req.signal.addEventListener("abort", cleanup, { once: true });
        },
        cancel() {
          cleanup();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    }
    if (path.startsWith("/api/tool/") && req.method === "POST") {
      const name = path.slice(10) as ToolName;
      if (!Object.hasOwn(toolSchemas, name)) {
        return json({ error: "Unknown tool" }, 404);
      }
      if ("program" in principal && name === "shell") {
        throw new robot.ApiError("Nested development shells are disabled", 403);
      }
      return json(
        await executeTool(name, await parse(req), principal, req.signal)
      );
    }
    if (path.startsWith("/api/cameras/")) {
      const camera = path.split("/").at(-1)!;
      if (!["workspace", "wrist"].includes(camera)) {
        return json({ error: "Unknown camera" }, 404);
      }
      const frame = await robot.capture(camera);
      return new Response(Buffer.from(frame.base64, "base64"), {
        headers: {
          "Content-Type": frame.media_type,
          "Cache-Control": "no-store",
          "X-Frame-Id": frame.id,
        },
      });
    }
    if (path === "/api/budget" && req.method === "POST") {
      requireHuman(principal);
      return json(
        setBudget(z.object({ limit: z.number() }).parse(await parse(req)).limit)
      );
    }
    if (path === "/api/conversations") {
      return json(agent.conversations());
    }
    if (path.startsWith("/api/conversations/")) {
      const id = path.split("/").at(-1)!;
      if (!z.string().uuid().safeParse(id).success) {
        throw new robot.ApiError("Invalid conversation", 400);
      }
      const conversation = db
        .query("SELECT id,provider,model,created FROM conversations WHERE id=?")
        .get(id);
      if (!conversation) {
        throw new robot.ApiError("Conversation not found", 404);
      }
      const rows = db
        .query(
          "SELECT id,time,type,data FROM events WHERE json_extract(data,'$.session_id')=? AND type!='chat.delta' ORDER BY id DESC LIMIT 500"
        )
        .all(id) as {
        id: number;
        time: number;
        type: string;
        data: string;
      }[];
      return json({
        conversation,
        events: rows.reverse().map((e) => ({ ...e, data: JSON.parse(e.data) })),
      });
    }
    if (path === "/api/chat" && req.method === "POST") {
      requireHuman(principal);
      const body = z
        .object({
          provider: z.string(),
          text: z.string().min(1).max(24_000),
          session_id: z.string().uuid().optional(),
        })
        .parse(await parse(req));
      return json(
        await agent.startChat(body.provider, body.text, body.session_id)
      );
    }
    if (path === "/api/chat/cancel" && req.method === "POST") {
      requireHuman(principal);
      return json(
        agent.cancel(z.object({ id: z.string() }).parse(await parse(req)).id)
      );
    }
    if (path === "/api/chat/steer" && req.method === "POST") {
      requireHuman(principal);
      const b = z
        .object({ id: z.string(), text: z.string().min(1).max(4000) })
        .parse(await parse(req));
      agent.steer(b.id, b.text);
      return json({ ok: true });
    }
    if (path === "/api/recordings") {
      return json(recording.recordings());
    }
    if (path.startsWith("/api/recordings/") && path.endsWith("/replay.rrd")) {
      const id = path.split("/")[3];
      if (!z.string().uuid().safeParse(id).success) {
        return json({ error: "Invalid recording" }, 400);
      }
      const file = Bun.file(`${config.dataDir}/recordings/${id}/replay.rrd`);
      if (!(await file.exists())) {
        return json(
          { error: "Rerun replay is not available for this recording" },
          404
        );
      }
      return new Response(file, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    if (path.startsWith("/api/perception/")) {
      const id = path.split("/")[3];
      if (!z.string().uuid().safeParse(id).success) {
        return json({ error: "Invalid artifact" }, 400);
      }
      const file = Bun.file(`${config.dataDir}/perception/${id}/preview.png`);
      return (await file.exists())
        ? new Response(file)
        : json({ error: "Artifact unavailable" }, 404);
    }
    if (
      path.startsWith("/rerun/") ||
      path.startsWith("/rerun.") ||
      path === "/proxy"
    ) {
      const viewer = path.startsWith("/rerun/viewer");
      const suffix = viewer
        ? path.slice("/rerun/viewer".length)
        : path.startsWith("/rerun/")
          ? path.slice("/rerun".length)
          : path;
      const response = await fetch(
        (viewer ? config.rerunWeb : config.rerunGrpc) +
          (suffix || "/") +
          url.search,
        {
          method: req.method,
          headers: {
            "Content-Type":
              req.headers.get("content-type") ?? "application/octet-stream",
            "X-Grpc-Web": "1",
          },
          body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
          signal: req.signal,
          duplex: "half",
        } as RequestInit
      );
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.delete("access-control-allow-origin");
      return new Response(response.body, { status: response.status, headers });
    }
    return json({ error: "Not found" }, 404);
  }
  const filePath = resolve(config.webDist, `.${path}`);
  const base = resolve(config.webDist);
  if (!filePath.startsWith(base + sep) && filePath !== base) {
    return json({ error: "Invalid path" }, 400);
  }
  const file = Bun.file(filePath);
  if ((await file.exists()) && path !== "/") {
    return new Response(file);
  }
  const index = Bun.file(`${config.webDist}/index.html`);
  return (await index.exists())
    ? new Response(index)
    : new Response(
        "Frontend not built. Run bun run build or open the Vite development URL.",
        { status: 503 }
      );
}
export const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  idleTimeout: 60,
  maxRequestBodySize: 65_536,
  async fetch(req) {
    try {
      return await handle(req);
    } catch (error) {
      if (error instanceof z.ZodError)
        return json(
          {
            error: "Invalid request",
            issues: error.issues.map((i) => ({
              path: i.path,
              message: i.message,
            })),
          },
          400
        );
      if (error instanceof robot.ApiError)
        return json({ error: error.message }, error.status);
      return json(
        { error: "Service request failed; check component status" },
        502
      );
    }
  },
});
let sampling = false;
const sampler = setInterval(() => {
  if (sampling) {
    recording.noteMissedSample();
    return;
  }
  sampling = true;
  void robot
    .sample()
    .then(() => recording.recordSample())
    .catch((error: unknown) => {
      console.error(
        "Sampler failure:",
        error instanceof Error ? error.message : String(error)
      );
    })
    .finally(() => {
      sampling = false;
    });
}, 100);
subscribe((event) => {
  void recording.recordEvent(event).catch(() => {});
});
console.log(`Robo Harness listening on http://${config.host}:${config.port}`);
console.log(
  config.accessMode === "tailnet"
    ? "Tailscale access enabled; no operator login."
    : `Operator token is stored in ${
        config.dataDir
      }/operator-token (not printed).`
);
async function shutdown() {
  clearInterval(sampler);
  clearInterval(sweeper);
  await robot.stop().catch(() => {});
  if (recording.active) {
    await recording.stopRecording().catch(() => {});
  }
  for (const id of agent.running()) {
    agent.cancel(id);
  }
  server.stop(true);
  db.close();
  process.exit(0);
}
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
