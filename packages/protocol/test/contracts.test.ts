import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { moveSchema, std, toolSchemas } from "../src/index";

const decode = <S extends Schema.Codec<any>>(schema: S, value: unknown) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

describe("public motion contract", () => {
  test("partial joint moves are valid", () => {
    const parsed = decode(moveSchema, {
      request_id: "a",
      target: { gripper: 42 },
    });
    expect("target" in parsed ? parsed.target : null).toEqual({ gripper: 42 });
  });
  test("motion target modes are exclusive", () => {
    expect(() => decode(moveSchema, { request_id: "a" })).toThrow();
    expect(() =>
      decode(moveSchema, {
        request_id: "a",
        target: { gripper: 42 },
        xyz: [0, 0, 0],
      })
    ).toThrow();
  });
  test("rejects non-finite angles and unknown joints", () => {
    expect(() =>
      decode(moveSchema, { request_id: "a", target: { gripper: Number.NaN } })
    ).toThrow();
    expect(() =>
      decode(moveSchema, { request_id: "a", target: { typo: 1 } })
    ).toThrow();
  });
  test("bounded command duration and no injected ownership", () => {
    expect(() =>
      decode(moveSchema, {
        request_id: "a",
        target: { gripper: 42 },
        duration_s: 100,
      })
    ).toThrow();
    expect(() =>
      decode(moveSchema, {
        request_id: "a",
        target: { gripper: 42 },
        owner: "human",
      })
    ).toThrow();
  });
  test("shell time and perception capability are bounded", () => {
    expect(() =>
      decode(toolSchemas.shell, { command: "echo hi", timeout_s: 121 })
    ).toThrow();
    expect(() =>
      decode(toolSchemas.perceive, { camera: "wrist", kind: "unknown" })
    ).toThrow();
  });
  test("defaults apply and the model sees a JSON Schema", () => {
    expect(decode(toolSchemas.acquire, {})).toEqual({
      mode: "agent",
      takeover: false,
    });
    const schema = std(toolSchemas.capture);
    expect(typeof schema["~standard"].validate).toBe("function");
    expect(typeof schema["~standard"].jsonSchema).toBe("object");
  });
});
