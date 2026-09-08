import type { ModelCapabilities } from "@robo/domain";

const alibabaVision = new Set([
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "kimi-k2.5",
]);
const alibabaText = new Set([
  "qwen3-max-2026-01-23",
  "qwen3-coder-next",
  "qwen3-coder-plus",
  "glm-5",
  "glm-4.7",
  "MiniMax-M2.5",
]);

export const modelCapabilities = (
  provider: string,
  endpoint: string,
  model: string,
  options: {
    visionModels?: readonly string[];
    disableVision?: boolean;
  } = {}
): ModelCapabilities => {
  const host = new URL(endpoint).hostname;
  const alibaba =
    provider === "alibaba" &&
    (host.endsWith(".aliyuncs.com") || host.endsWith(".alibabacloud.com"));
  const xai = provider === "xai" && host === "api.x.ai";
  const documented =
    (alibaba && (alibabaVision.has(model) || alibabaText.has(model))) ||
    (xai && model === "grok-4.6");
  const configured = options.visionModels?.includes(model) ?? false;
  return {
    model,
    image_input:
      !options.disableVision &&
      (configured ||
        (alibaba && alibabaVision.has(model)) ||
        (xai && model === "grok-4.6")),
    tool_calling: true,
    strict_tools: false,
    parallel_control: provider === "alibaba" || xai,
    source:
      configured || options.disableVision
        ? "configured"
        : documented
          ? "documented"
          : "unverified",
  };
};
