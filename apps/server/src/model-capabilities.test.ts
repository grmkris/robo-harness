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

test("the cliproxy gateway inherits image support, and says it was inherited", () => {
  const gateway = "http://127.0.0.1:8317/v1";
  expect(modelCapabilities("alibaba", gateway, "qwen3.8-max").image_input).toBe(
    true
  );
  expect(
    modelCapabilities("alibaba", gateway, "qwen3-coder-next").image_input
  ).toBe(false);
  expect(modelCapabilities("xai", gateway, "grok-4.6").image_input).toBe(true);
  expect(modelCapabilities("xai", gateway, "grok-4.7").image_input).toBe(true);
  // Which upstream a gateway alias forwards to is the gateway's config, so
  // the claim is an inheritance rather than the vendor's documentation.
  expect(modelCapabilities("xai", gateway, "grok-4.7").source).toBe("gateway");
  expect(modelCapabilities("xai", gateway, "grok-4.6").source).toBe("gateway");
  expect(modelCapabilities("alibaba", gateway, "qwen3.8-max").source).toBe(
    "gateway"
  );
  // At the vendor's own endpoint the same model is documented.
  expect(
    modelCapabilities("xai", "https://api.x.ai/v1", "grok-4.7").source
  ).toBe("documented");
  expect(modelCapabilities("alibaba", endpoint, "qwen3.8-max").source).toBe(
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

test("an IPv6 loopback gateway is a gateway", () => {
  // URL.hostname keeps the brackets, so a plain string compare missed this and
  // the endpoint silently lost its image support.
  const gateway = "http://[::1]:8317/v1";
  expect(modelCapabilities("xai", gateway, "grok-4.7").image_input).toBe(true);
  expect(modelCapabilities("xai", gateway, "grok-4.7").source).toBe("gateway");
  expect(modelCapabilities("alibaba", gateway, "qwen3.8-max").image_input).toBe(
    true
  );
});

test("an unrelated host inherits nothing, whatever the model", () => {
  const elsewhere = "https://api.example.invalid/v1";
  expect(modelCapabilities("xai", elsewhere, "grok-4.7").image_input).toBe(
    false
  );
  expect(modelCapabilities("xai", elsewhere, "grok-4.7").source).toBe(
    "unverified"
  );
  // A name that merely ends in something gateway-ish is not the tailnet.
  expect(
    modelCapabilities("xai", "https://ts.net.example.invalid/v1", "grok-4.7")
      .image_input
  ).toBe(false);
});
