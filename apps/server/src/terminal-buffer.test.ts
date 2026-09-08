import { expect, test } from "bun:test";

import { replayBuffer, terminalOutput } from "./terminal-buffer";

test("PTY output preserves split UTF-8 and redacts split capability tokens without delaying prompts", () => {
  const token = "abc123secret";
  const read = terminalOutput(token);
  const encode = new TextEncoder();
  const bytes = encode.encode("🦾");
  expect(read(bytes.slice(0, 2))).toBe("");
  expect(read(bytes.slice(2))).toBe("🦾");
  expect(read(encode.encode("workspace $ "))).toBe("workspace $ ");
  expect(read(encode.encode("token=abc123"))).toBe("token=");
  expect(read(encode.encode("secret\r\n"))).toBe("[program token]\r\n");
});

test("replay has a fixed byte budget and retains Unicode codepoints", () => {
  const ring = replayBuffer(32);
  ring.append("old output\n");
  ring.append("🦾".repeat(30));
  expect(new TextEncoder().encode(ring.read()).byteLength).toBeLessThanOrEqual(
    32
  );
  expect(ring.read()).not.toContain("�");
  expect(ring.read()).toContain("🦾");
});
