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
  // URL.hostname keeps the brackets on an IPv6 literal.
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  // The cliproxy gateway (loopback on netcup, *.ts.net on the tailnet) fronts
  // the same upstream models, so capability claims carry over to it -- but
  // only by assumption. Which model a gateway alias forwards to is the
  // gateway's config, not something this code can see, so support inherited
  // this way is reported as `gateway` rather than `documented`: it is the
  // shape of the URL talking, not the vendor.
  const gateway = loopback.has(host) || host.endsWith(".ts.net");
  const alibabaVendor =
    host.endsWith(".aliyuncs.com") || host.endsWith(".alibabacloud.com");
  const xaiVendor = host === "api.x.ai";
  const alibaba = provider === "alibaba" && (gateway || alibabaVendor);
  const xai = provider === "xai" && (gateway || xaiVendor);
  // The generic `cliproxy` provider names models by the gateway's aliases, so
  // it inherits whatever the vendor tables know about the same name -- and
  // only through a gateway-shaped URL.
  const cliproxy = provider === "cliproxy" && gateway;
  // grok-4.7 (2026-09-21) and grok-4.6 document image input
  const xaiVision = new Set(["grok-4.7", "grok-4.6"]);
  const known =
    ((alibaba || cliproxy) &&
      (alibabaVision.has(model) || alibabaText.has(model))) ||
    ((xai || cliproxy) && xaiVision.has(model));
  const atVendor =
    (provider === "alibaba" && alibabaVendor) ||
    (provider === "xai" && xaiVendor);
  const configured = options.visionModels?.includes(model) ?? false;
  return {
    model,
    image_input:
      !options.disableVision &&
      (configured ||
        ((alibaba || cliproxy) && alibabaVision.has(model)) ||
        ((xai || cliproxy) && xaiVision.has(model))),
    tool_calling: true,
    strict_tools: false,
    // Whether the request carries `parallel_tool_calls: false`. The generic
    // gateway provider never sends it: some of the upstreams it fronts reject
    // the field, and the chat tools already refuse a second mutating call in
    // one response (MOTION_BUSY), so the wire flag is not what keeps motion
    // sequential.
    parallel_control: provider === "alibaba" || xai,
    source:
      configured || options.disableVision
        ? "configured"
        : known
          ? atVendor
            ? "documented"
            : "gateway"
          : "unverified",
  };
};
