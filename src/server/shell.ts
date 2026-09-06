import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { issueCapability } from "./capabilities";
import { config } from "./config";
import { emit } from "./store";
import { ApiError } from "./robot";
export async function shell(
  input: { command: string; host: "netcup" | "pi"; timeout_s: number },
  owner: string,
  signal?: AbortSignal,
) {
  const id = crypto.randomUUID();
  const workspace =
    config.dataDir + "/workspaces/" + owner.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
  await mkdir(workspace, { recursive: true });
  await mkdir(config.dataDir + "/programs", { recursive: true });
  const hash = createHash("sha256").update(input.command).digest("hex");
  await writeFile(config.dataDir + "/programs/" + hash + ".sh", input.command, {
    mode: 0o600,
  });
  let command: string[];
  if (input.host === "pi") {
    const host = process.env.ROBO_PI_DEV_HOST;
    if (!host)
      throw new ApiError(
        "Configure a dedicated Pi development SSH account first",
        422,
      );
    if (!/^[a-zA-Z0-9_.@-]+$/.test(host))
      throw new ApiError("Invalid configured Pi development host", 422);
    // Remote account must be separate from the motor-service identity, with no sudo/device privileges.
    command = [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      host,
      "robo-dev-shell",
      String(input.timeout_s),
    ];
  } else {
    command = [
      "docker",
      "run",
      "--rm",
      "--name",
      "robo-shell-" + id,
      "--interactive",
      "--init",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      "--memory=2g",
      "--cpus=2",
      "--user",
      String(process.getuid?.() ?? 1000) +
        ":" +
        String(process.getgid?.() ?? 1000),
      "--mount",
      "type=bind,source=" + workspace + ",target=/workspace",
      "--workdir",
      "/workspace",
      "--env",
      "HOME=/workspace",
      "--env",
      "PIP_USER=1",
      process.env.ROBO_DEV_IMAGE ?? "robo-harness-dev:local",
      "sh",
      "-s",
    ];
  }
  const capability = issueCapability(id, input.timeout_s + 5);
  if (input.host === "netcup") {
    const at = command.indexOf("--workdir");
    command.splice(
      at,
      0,
      "--network",
      "host",
      "--env",
      "ROBO_URL=" +
        (process.env.ROBO_PROGRAM_URL ??
          "http://" + config.host + ":" + config.port),
      "--env",
      "ROBO_TOKEN=" + capability.token,
    );
  }
  const proc = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  proc.stdin.write(
    input.host === "pi"
      ? JSON.stringify({
          command: input.command,
          token: capability.token,
          url: process.env.ROBO_PI_PROGRAM_URL ?? "",
        })
      : input.command,
  );
  proc.stdin.end();
  let killed = false;
  const cancel = () => {
    killed = true;
    proc.kill("SIGTERM");
    if (input.host === "netcup")
      Bun.spawn(["docker", "rm", "-f", "robo-shell-" + id], {
        stdout: "ignore",
        stderr: "ignore",
      });
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, input.timeout_s * 1000);
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    let text = "",
      bytes = 0;
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes <= 128000) text += decoder.decode(value, { stream: true });
    }
    return text + (bytes > 128000 ? "\n[output truncated]" : "");
  };
  try {
    const [stdout, stderr, code] = await Promise.all([
      collect(proc.stdout),
      collect(proc.stderr),
      proc.exited,
    ]);
    const result = {
      id,
      host: input.host,
      code,
      killed,
      stdout: stdout.replaceAll(capability.token, "[redacted program token]"),
      stderr: stderr.replaceAll(capability.token, "[redacted program token]"),
      program_sha256: hash,
    };
    emit("shell.completed", {
      id,
      host: input.host,
      code,
      killed,
      program_sha256: hash,
    });
    return result;
  } finally {
    capability.revoke();
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
