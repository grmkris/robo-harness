import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Config, Effect, Option } from "effect";

import { isLoopback, isTailnetAddress } from "./access";

// Configuration is read once, through Effect's Config, and resolved to a plain
// object the rest of the coordinator reads synchronously. The reads run under
// Effect.runSync because they only touch the environment and the data directory.
function loadSecret(
  dataDir: string,
  name: string,
  provided: Option.Option<string>
) {
  if (Option.isSome(provided)) {
    if (provided.value.length < 24) {
      throw new Error(`${name} must contain at least 24 characters`);
    }
    return provided.value;
  }
  const path = `${dataDir}/${name}`;
  if (!existsSync(path)) {
    writeFileSync(path, crypto.randomUUID() + crypto.randomUUID(), {
      mode: 0o600,
    });
  }
  return readFileSync(path, "utf-8").trim();
}

const load = Effect.gen(function* load() {
  const root = resolve(import.meta.dir, "../../..");
  const dataDir = resolve(
    yield* Config.string("ROBO_DATA_DIR").pipe(
      Config.withDefault(`${root}/var`)
    )
  );
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const webDist = resolve(
    yield* Config.string("ROBO_WEB_DIST").pipe(
      Config.withDefault(`${root}/apps/web/dist`)
    )
  );
  const host = yield* Config.string("ROBO_HOST").pipe(
    Config.withDefault("127.0.0.1")
  );
  const port = yield* Config.number("ROBO_PORT").pipe(Config.withDefault(8940));
  const accessMode = yield* Config.string("ROBO_ACCESS_MODE").pipe(
    Config.withDefault("tailnet")
  );
  const ioUrl = yield* Config.string("ROBO_IO_URL").pipe(
    Config.withDefault("http://127.0.0.1:8941")
  );
  const rerunWeb = yield* Config.string("ROBO_RERUN_WEB").pipe(
    Config.withDefault("http://127.0.0.1:8942")
  );
  const rerunGrpc = yield* Config.string("ROBO_RERUN_GRPC").pipe(
    Config.withDefault("http://127.0.0.1:8943")
  );
  const originList = yield* Config.string("ROBO_ALLOWED_ORIGINS").pipe(
    Config.withDefault("")
  );
  const trustLoopback = yield* Config.string("ROBO_TRUST_LOOPBACK").pipe(
    Config.option
  );
  const piDevHostRaw = yield* Config.string("ROBO_PI_DEV_HOST").pipe(
    Config.option
  );
  const secret = (name: string, envName: string) =>
    Config.string(envName).pipe(
      Config.option,
      Effect.map((provided) => loadSecret(dataDir, name, provided))
    );
  const token = yield* secret("operator-token", "ROBO_TOKEN");
  const agentToken = yield* secret("agent-token", "ROBO_AGENT_TOKEN");
  const ioToken = yield* secret("io-token", "ROBO_IO_TOKEN");
  const workerToken = yield* secret("worker-token", "ROBO_WORKER_TOKEN");

  if (!isLoopback(host) && !isTailnetAddress(host)) {
    throw new Error("Bind to loopback or a Tailscale address");
  }
  if (accessMode !== "tailnet" && accessMode !== "token") {
    throw new Error("ROBO_ACCESS_MODE must be tailnet or token");
  }

  // Browsers may only issue commands from origins listed here; the list is never
  // derived from the request itself, so a DNS-rebound page cannot match itself.
  const allowedOrigins = new Set([
    `http://${host}:${port}`,
    ...originList
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ]);
  const piDevHost =
    Option.getOrUndefined(piDevHostRaw)?.split("@").at(-1) ?? "";
  // Loopback is trusted when the server is bound there unless ROBO_TRUST_LOOPBACK
  // overrides it; the robot host and Pi development account never are.
  const trust = {
    loopback:
      Option.getOrUndefined(trustLoopback) === "1" ||
      (Option.getOrUndefined(trustLoopback) !== "0" && isLoopback(host)),
    blocked: new Set(
      [new URL(ioUrl).hostname, piDevHost].filter(
        (value) => value && !isLoopback(value)
      )
    ),
  };
  return {
    root,
    dataDir,
    webDist,
    accessMode,
    token,
    agentToken,
    ioToken,
    workerToken,
    host,
    port,
    allowedOrigins,
    trust,
    ioUrl,
    rerunWeb,
    rerunGrpc,
  };
});

export const config = Effect.runSync(load);
