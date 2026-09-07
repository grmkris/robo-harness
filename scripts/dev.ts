import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { config } from "../apps/server/src/config";

const children: ChildProcess[] = [];
let stopping = false;
function shutdown() {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    if (child.pid)
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    }
    process.exit(0);
  }, 4000);
}
function start(
  command: [string, ...string[]],
  extra: Record<string, string> = {}
) {
  const [binary, ...args] = command;
  const child = spawn(binary, args, {
    cwd: config.root,
    env: { ...process.env, ...extra },
    stdio: "inherit",
    detached: true,
  });
  children.push(child);
  child.on("exit", shutdown);
  child.on("error", shutdown);
}
if (
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.ioUrl).hostname)
) {
  start([`${config.root}/.venv/bin/python`, "-m", "robo_harness.service"], {
    ROBO_IO_TOKEN: config.ioToken,
  });
}
start(["bun", "src/server/main.ts"], {
  ROBO_ALLOWED_ORIGINS: "http://127.0.0.1:5178",
  // Development binds to loopback, which bridge containers cannot reach. Host
  // networking is acceptable here only because the hardware is mocked.
  ROBO_SHELL_NETWORK: process.env["ROBO_SHELL_NETWORK"] ?? "host",
});
start([`${config.root}/.venv/bin/python`, "-m", "robo_harness.telemetry"], {
  ROBO_WORKER_TOKEN: config.workerToken,
  ROBO_URL: `http://${config.host}:${config.port}`,
  ROBO_DATA_DIR: config.dataDir,
});
start(["bun", "--filter", "@robo/web", "dev"]);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
