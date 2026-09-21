import { expect, test } from "bun:test";

import { modelCapabilities } from "./model-capabilities";

const endpoint =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

test("image support is specific to the model and endpoint", () => {
  expect(
    modelCapabilities("alibaba", endpoint, "qwen3.8-max").image_input
  ).toBe(true);
  expect(
    modelCapabilities("alibaba", endpoint, "qwen3-coder-next").image_input
  ).toBe(false);
  expect(
    modelCapabilities("alibaba", "https://example.invalid/v1", "qwen3.8-max")
      .image_input
  ).toBe(false);
  expect(modelCapabilities("alibaba", endpoint, "unknown").source).toBe(
    "unverified"
  );
  expect(
    modelCapabilities("alibaba", endpoint, "qwen3.8-max").strict_tools
  ).toBe(false);
});

test("an explicit model override does not enable vision for other models", () => {
  const options = { visionModels: ["custom"] };
  expect(
    modelCapabilities("alibaba", endpoint, "custom", options).image_input
  ).toBe(true);
  expect(
    modelCapabilities("alibaba", endpoint, "other", options).image_input
  ).toBe(false);
  expect(
    modelCapabilities("alibaba", endpoint, "qwen3.8-max", {
      disableVision: true,
    }).image_input
  ).toBe(false);
});

test("the cliproxy gateway inherits documented image support", () => {
  const gateway = "http://127.0.0.1:8317/v1";
  expect(modelCapabilities("alibaba", gateway, "qwen3.8-max").image_input).toBe(
    true
  );
  expect(
    modelCapabilities("alibaba", gateway, "qwen3-coder-next").image_input
  ).toBe(false);
  expect(modelCapabilities("xai", gateway, "grok-4.6").image_input).toBe(true);
  expect(modelCapabilities("xai", gateway, "grok-4.7").image_input).toBe(true);
  expect(modelCapabilities("xai", gateway, "grok-4.7").source).toBe(
    "documented"
  );
  expect(modelCapabilities("xai", gateway, "grok-4.6").source).toBe(
    "documented"
  );
  expect(
    modelCapabilities(
      "xai",
      "https://netcup.tail5acf67.ts.net:8443/v1",
      "grok-4.6"
    ).image_input
  ).toBe(true);
});
