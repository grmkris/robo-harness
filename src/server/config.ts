import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { isLoopback, isTailnetAddress } from "./access";

export const root = resolve(import.meta.dir, "../..");
export const dataDir = resolve(process.env["ROBO_DATA_DIR"] ?? `${root}/var`);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
function secret(name: string, environment?: string) {
  if (environment) {
    if (environment.length < 24) {
      throw new Error(name + " must contain at least 24 characters");
    }
    return environment;
  }
  const path = `${dataDir}/${name}`;
  if (!existsSync(path)) {
    writeFileSync(path, crypto.randomUUID() + crypto.randomUUID(), {
      mode: 0o600,
    });
  }
  return readFileSync(path, "utf-8").trim();
}
const host = process.env["ROBO_HOST"] ?? "127.0.0.1";
const port = Number(process.env["ROBO_PORT"] ?? 8940);
// Browsers may only issue commands from origins listed here. The list is never
// derived from the request itself: a Host header is attacker-controlled, and a
// DNS-rebound page would otherwise match its own origin.
const allowedOrigins = new Set([
  `http://${host}:${port}`,
  ...(process.env["ROBO_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
]);
const ioUrl = process.env["ROBO_IO_URL"] ?? "http://127.0.0.1:8941";
const piDevHost = process.env["ROBO_PI_DEV_HOST"]?.split("@").at(-1) ?? "";
// Who may act without a credential in tailnet mode. Loopback is trusted when the
// server is bound there (only local processes can connect) unless ROBO_TRUST_LOOPBACK
// says otherwise; the robot host and the Pi development account never are.
const trust = {
  loopback:
    process.env["ROBO_TRUST_LOOPBACK"] === "1" ||
    (process.env["ROBO_TRUST_LOOPBACK"] !== "0" && isLoopback(host)),
  blocked: new Set(
    [new URL(ioUrl).hostname, piDevHost].filter(
      (value) => value && !isLoopback(value)
    )
  ),
};
export const config = {
  root,
  dataDir,
  accessMode: process.env["ROBO_ACCESS_MODE"] ?? "tailnet",
  token: secret("operator-token", process.env["ROBO_TOKEN"]),
  agentToken: secret("agent-token", process.env["ROBO_AGENT_TOKEN"]),
  ioToken: secret("io-token", process.env["ROBO_IO_TOKEN"]),
  workerToken: secret("worker-token", process.env["ROBO_WORKER_TOKEN"]),
  host,
  port,
  allowedOrigins,
  trust,
  ioUrl,
  rerunWeb: process.env["ROBO_RERUN_WEB"] ?? "http://127.0.0.1:8942",
  rerunGrpc: process.env["ROBO_RERUN_GRPC"] ?? "http://127.0.0.1:8943",
};
if (!isLoopback(config.host) && !isTailnetAddress(config.host)) {
  throw new Error("Bind to loopback or a Tailscale address");
}

if (!["tailnet", "token"].includes(config.accessMode)) {
  throw new Error("ROBO_ACCESS_MODE must be tailnet or token");
}
