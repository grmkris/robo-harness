import { afterEach, beforeEach, expect, test } from "bun:test";

import { catalog, resolveModel } from "./providers";

const keys = [
  "ROBO_CLIPROXY_URL",
  "ROBO_CLIPROXY_KEY",
  "ROBO_CLIPROXY_MODELS",
  "ROBO_CLIPROXY_VISION_MODELS",
  "ROBO_CLIPROXY_VISION",
  "XAI_API_KEY",
  "ROBO_XAI_AUTH_FILE",
  "DASHSCOPE_API_KEY",
  "ALIBABA_TOKEN_PLAN_API_KEY",
] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) Reflect.deleteProperty(process.env, key);
});
afterEach(() => {
  for (const key of keys) {
    const value = saved[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

const cliproxy = async () =>
  (await catalog()).find((provider) => provider.id === "cliproxy");

test("cliproxy is unavailable until it has models and a key", async () => {
  expect((await cliproxy())?.available).toBe(false);
  process.env["ROBO_CLIPROXY_MODELS"] = "gpt-6-astra";
  expect((await cliproxy())?.available).toBe(false);
  // The live coordinator already routes xAI through cliproxy with this key.
  process.env["XAI_API_KEY"] = "fallback-key-not-real";
  expect((await cliproxy())?.available).toBe(true);
});

test("cliproxy offers exactly the listed models with per-model vision", async () => {
  process.env["ROBO_CLIPROXY_KEY"] = "key-not-real";
  process.env["ROBO_CLIPROXY_MODELS"] =
    "gpt-6-astra, grok-4.7,claude-opus-5-5,gpt-6-astra";
  process.env["ROBO_CLIPROXY_VISION_MODELS"] = "claude-opus-5-5";
  const info = await cliproxy();
  expect(info?.models).toEqual(["gpt-6-astra", "grok-4.7", "claude-opus-5-5"]);
  expect(info?.model).toBe("gpt-6-astra");
  expect(
    info?.capabilities.map((entry) => [entry.model, entry.image_input])
  ).toEqual([
    ["gpt-6-astra", false],
    ["grok-4.7", true],
    ["claude-opus-5-5", true],
  ]);
});

test("cliproxy never sends parallel_tool_calls; the existing providers still do", async () => {
  process.env["ROBO_CLIPROXY_KEY"] = "key-not-real";
  process.env["ROBO_CLIPROXY_MODELS"] = "grok-4.7,qwen3.8-max";
  process.env["DASHSCOPE_API_KEY"] = "key-not-real";
  const gateway = await resolveModel("cliproxy", "qwen3.8-max");
  expect(gateway.modelOptions).toEqual({});
  expect(gateway.info.model).toBe("qwen3.8-max");
  expect(gateway.info.vision).toBe(true);
  expect((await resolveModel("alibaba")).modelOptions).toEqual({
    parallel_tool_calls: false,
  });
  await expect(resolveModel("cliproxy", "not-listed")).rejects.toThrow(
    "not available"
  );
});
