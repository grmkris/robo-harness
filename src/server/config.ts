import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
export const root = resolve(import.meta.dir, "../..");
export const dataDir = resolve(process.env.ROBO_DATA_DIR ?? root + "/var");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
function secret(name: string, environment?: string) {
  if (environment) {
    if (environment.length < 24)
      throw new Error(name + " must contain at least 24 characters");
    return environment;
  }
  const path = dataDir + "/" + name;
  if (!existsSync(path))
    writeFileSync(path, crypto.randomUUID() + crypto.randomUUID(), {
      mode: 0o600,
    });
  return readFileSync(path, "utf8").trim();
}
export const config = {
  root,
  dataDir,
  accessMode: process.env.ROBO_ACCESS_MODE ?? "tailnet",
  token: secret("operator-token", process.env.ROBO_TOKEN),
  agentToken: secret("agent-token", process.env.ROBO_AGENT_TOKEN),
  ioToken: secret("io-token", process.env.ROBO_IO_TOKEN),
  workerToken: secret("worker-token", process.env.ROBO_WORKER_TOKEN),
  host: process.env.ROBO_HOST ?? "127.0.0.1",
  port: Number(process.env.ROBO_PORT ?? 8940),
  ioUrl: process.env.ROBO_IO_URL ?? "http://127.0.0.1:8941",
  rerunWeb: process.env.ROBO_RERUN_WEB ?? "http://127.0.0.1:8942",
  rerunGrpc: process.env.ROBO_RERUN_GRPC ?? "http://127.0.0.1:8943",
};
if (
  !["127.0.0.1", "::1"].includes(config.host) &&
  !/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(config.host)
)
  throw new Error("Bind to loopback or a Tailscale address");

if (!["tailnet", "token"].includes(config.accessMode))
  throw new Error("ROBO_ACCESS_MODE must be tailnet or token");
