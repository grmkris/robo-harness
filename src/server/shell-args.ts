export type ShellNetwork = "bridge" | "host";
export interface DockerShellOptions {
  id: string;
  workspace: string;
  image: string;
  uid: number;
  gid: number;
  network: ShellNetwork;
  programUrl: string;
  token: string;
}
// Pure so the hardening flags can be asserted without Docker. Host networking
// would hand agent-authored code the motor service, the Rerun ports and the
// whole tailnet, which is why it is never the default.
export function dockerArguments(o: DockerShellOptions): string[] {
  return [
    "docker",
    "run",
    "--rm",
    "--name",
    `robo-shell-${o.id}`,
    "--interactive",
    "--init",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    "--memory=2g",
    "--cpus=2",
    "--user",
    `${o.uid}:${o.gid}`,
    "--mount",
    `type=bind,source=${o.workspace},target=/workspace`,
    "--network",
    o.network,
    "--env",
    `ROBO_URL=${o.programUrl}`,
    "--env",
    `ROBO_TOKEN=${o.token}`,
    "--workdir",
    "/workspace",
    "--env",
    "HOME=/workspace",
    "--env",
    "PIP_USER=1",
    o.image,
    "sh",
    "-s",
  ];
}
export function shellNetwork(value?: string): ShellNetwork {
  if (value === undefined || value === "" || value === "bridge") {
    return "bridge";
  }
  if (value === "host") {
    return "host";
  }
  throw new Error("ROBO_SHELL_NETWORK must be bridge or host");
}
