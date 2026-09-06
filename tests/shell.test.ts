import { describe, expect, test } from "bun:test";
import { dockerArguments, shellNetwork } from "../src/server/shell-args";
const base = {
  id: "abc",
  workspace: "/data/workspaces/x",
  image: "robo-harness-dev:local",
  uid: 1000,
  gid: 1000,
  programUrl: "http://100.105.51.45:8940",
  token: "program-token",
};
describe("dockerArguments", () => {
  test("uses the bridge network with every hardening flag", () => {
    const args = dockerArguments({ ...base, network: "bridge" });
    expect(args.join(" ")).not.toContain("--network host");
    expect(args[args.indexOf("--network") + 1]).toBe("bridge");
    for (const flag of [
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      "--memory=2g",
      "--cpus=2",
      "--init",
    ])
      expect(args).toContain(flag);
    expect(args).toContain("ROBO_URL=http://100.105.51.45:8940");
    expect(args).toContain("ROBO_TOKEN=program-token");
    expect(args.at(-3)).toBe("robo-harness-dev:local");
  });
  test("host networking only when explicitly configured", () => {
    expect(shellNetwork(undefined)).toBe("bridge");
    expect(shellNetwork("")).toBe("bridge");
    expect(shellNetwork("host")).toBe("host");
    expect(() => shellNetwork("none")).toThrow();
    expect(
      dockerArguments({ ...base, network: "host" })[
        dockerArguments({ ...base, network: "host" }).indexOf("--network") + 1
      ],
    ).toBe("host");
  });
});
