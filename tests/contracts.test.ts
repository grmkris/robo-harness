import { describe, test, expect } from "bun:test";
import { moveSchema, toolSchemas } from "../src/shared/contracts";
describe("public motion contract", () => {
  test("partial joint moves are valid", () =>
    expect(
      moveSchema.parse({ request_id: "a", target: { gripper: 42 } }).target,
    ).toEqual({ gripper: 42 }));
  test("motion target modes are exclusive", () => {
    expect(() => moveSchema.parse({ request_id: "a" })).toThrow();
    expect(() =>
      moveSchema.parse({
        request_id: "a",
        target: { gripper: 42 },
        xyz: [0, 0, 0],
      }),
    ).toThrow();
  });
  test("rejects non-finite angles and unknown joints", () => {
    expect(() =>
      moveSchema.parse({ request_id: "a", target: { gripper: NaN } }),
    ).toThrow();
    expect(() =>
      moveSchema.parse({ request_id: "a", target: { typo: 1 } }),
    ).toThrow();
  });
  test("bounded command duration and no injected ownership", () => {
    expect(() =>
      moveSchema.parse({
        request_id: "a",
        target: { gripper: 42 },
        duration_s: 100,
      }),
    ).toThrow();
    expect(() =>
      moveSchema.parse({
        request_id: "a",
        target: { gripper: 42 },
        owner: "human",
      }),
    ).toThrow();
  });
  test("shell time and perception capability are bounded", () => {
    expect(() =>
      toolSchemas.shell.parse({ command: "echo hi", timeout_s: 121 }),
    ).toThrow();
    expect(() =>
      toolSchemas.perceive.parse({ camera: "wrist", kind: "unknown" }),
    ).toThrow();
  });
});
