import { mkdir } from "node:fs/promises";

import { isLoopback } from "./access";
import { issueCapability } from "./capabilities";
import { config } from "./config";
import { ApiError, release } from "./robot";
import { dockerArguments } from "./shell-args";
import { emit } from "./store";
import { terminalOutput } from "./terminal-buffer";
import { createTerminalManager, type LaunchTerminal } from "./terminal-manager";

const launch: LaunchTerminal = async (options) => {
  const programUrl =
    process.env["ROBO_PROGRAM_URL"] ??
    (isLoopback(config.host) ? null : `http://${config.host}:${config.port}`);
  if (!programUrl)
    throw new ApiError(
      "Configure the development container API address first",
      422
    );
  const workspace = `${config.dataDir}/workspaces/${options.owner.replaceAll(/[^a-zA-Z0-9_-]/gu, "_")}`;
  await mkdir(workspace, { recursive: true });
  const capability = issueCapability(options.id, options.lifetimeMs / 1000 + 5);
  const output = terminalOutput(capability.token);
  const env = { PATH: process.env["PATH"], HOME: process.env["HOME"] };
  let terminal: Bun.Terminal | undefined;
  try {
    const pty = new Bun.Terminal({
      cols: options.cols,
      rows: options.rows,
      name: "xterm-256color",
      data: (_term, bytes) => {
        const text = output(bytes);
        if (text) options.output(text);
      },
    });
    terminal = pty;
    // Docker owns the inner TTY. Keep its outer transport raw from the start,
    // including input entered before Docker finishes attaching.
    pty.setRawMode(true);
    const proc = Bun.spawn(
      dockerArguments({
        id: options.id,
        workspace,
        image: process.env["ROBO_DEV_IMAGE"] ?? "robo-harness-dev:local",
        uid: process.getuid?.() ?? 1000,
        gid: process.getgid?.() ?? 1000,
        network: "bridge",
        programUrl,
        token: capability.token,
        terminal: { lifetimeSeconds: Math.ceil(options.lifetimeMs / 1000) },
      }),
      { terminal: pty, env }
    );
    emit("terminal.opened", { id: options.id, owner: options.owner });
    return {
      write: (data: string) => {
        pty.write(data);
      },
      resize: (cols: number, rows: number) => pty.resize(cols, rows),
      exited: proc.exited,
      close: async () => {
        capability.revoke();
        await release(`program-${options.id}`).catch(() => {});
        try {
          const removal = Bun.spawn(
            ["docker", "rm", "--force", `robo-shell-${options.id}`],
            { env, stdout: "ignore", stderr: "ignore", timeout: 3000 }
          );
          await removal.exited;
        } finally {
          proc.kill("SIGKILL");
          pty.close();
          emit("terminal.closed", { id: options.id, code: proc.exitCode });
        }
      },
    };
  } catch {
    terminal?.close();
    capability.revoke();
    throw new ApiError("Could not launch the development terminal", 502);
  }
};
export const terminals = createTerminalManager(launch);
