import { readFile } from "node:fs/promises";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderInfo } from "@robo/domain";

import { ApiError } from "./robot";

const alibaba =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
// The token-plan key is stored as ALIBABA_TOKEN_PLAN_API_KEY on this machine;
// accept it as well as the OpenAI-compatible DASHSCOPE_API_KEY name.
const alibabaKey = () =>
  process.env["DASHSCOPE_API_KEY"] ?? process.env["ALIBABA_TOKEN_PLAN_API_KEY"];
async function xaiToken() {
  if (process.env["XAI_API_KEY"]) {
    return process.env["XAI_API_KEY"];
  }
  const path = process.env["ROBO_XAI_AUTH_FILE"];
  if (!path) {
    return null;
  }
  try {
    const file = JSON.parse(await readFile(path, "utf-8"));
    const record = Object.entries(file).find(([key]) =>
      key.startsWith("https://auth.x.ai::")
    )?.[1] as { key?: string; expires_at?: string | number } | undefined;
    if (!record?.key) {
      return null;
    }
    const expiry = record.expires_at;
    const ms =
      typeof expiry === "number"
        ? expiry < 1e12
          ? expiry * 1000
          : expiry
        : typeof expiry === "string"
          ? Number.isFinite(Number(expiry))
            ? Number(expiry) < 1e12
              ? Number(expiry) * 1000
              : Number(expiry)
            : Date.parse(expiry)
          : 0;
    if (!Number.isFinite(ms) || ms < Date.now() + 60_000) {
      return null;
    }
    return record.key;
  } catch {
    return null;
  }
}
// A provider's selectable models: the default first, plus any extras from a
// comma-separated `ROBO_<PROVIDER>_MODELS` env, de-duplicated. Keeping the list
// env-driven means only models the account can actually serve are offered.
function modelList(defaultModel: string, extrasEnv: string): string[] {
  const extras = (process.env[extrasEnv] ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return [...new Set([defaultModel, ...extras])];
}
export async function catalog(): Promise<ProviderInfo[]> {
  const xai = Boolean(await xaiToken());
  const alibabaModels = modelList(
    process.env["ROBO_ALIBABA_MODEL"] ?? "qwen3.8-max",
    "ROBO_ALIBABA_MODELS"
  );
  const xaiModels = modelList(
    process.env["ROBO_XAI_MODEL"] ?? "grok-4.6",
    "ROBO_XAI_MODELS"
  );
  return [
    {
      id: "alibaba",
      name: "Alibaba Token Plan",
      available: Boolean(alibabaKey()),
      model: alibabaModels[0] ?? "qwen3.8-max",
      models: alibabaModels,
      vision: process.env["ROBO_ALIBABA_VISION"] === "1",
      ...(alibabaKey()
        ? {}
        : { reason: "Set DASHSCOPE_API_KEY or ALIBABA_TOKEN_PLAN_API_KEY" }),
    },
    {
      id: "xai",
      name: "xAI / Grok",
      available: xai,
      model: xaiModels[0] ?? "grok-4.6",
      models: xaiModels,
      vision: process.env["ROBO_XAI_VISION"] !== "0",
      ...(xai
        ? {}
        : {
            reason: "Configure XAI_API_KEY or an explicit fresh Grok auth file",
          }),
    },
    {
      id: "claude",
      name: "Claude",
      available: false,
      model: "",
      models: [],
      vision: true,
      reason: "Direct subscription adapter pending verification",
    },
    {
      id: "codex",
      name: "Codex",
      available: false,
      model: "",
      models: [],
      vision: true,
      reason: "Direct subscription adapter pending verification",
    },
  ];
}
export async function resolveModel(provider: string, model?: string) {
  const info = (await catalog()).find((p) => p.id === provider);
  if (!info?.available) {
    throw new ApiError(info?.reason ?? "Unknown provider", 422);
  }
  // A caller may choose any of the provider's advertised models; anything else
  // is refused rather than silently sent to the API.
  if (model !== undefined && !info.models.includes(model)) {
    throw new ApiError(`Model ${model} is not available for ${provider}`, 422);
  }
  const chosen = model ?? info.model;
  const key = alibabaKey();
  const client = createOpenAICompatible({
    name: provider,
    baseURL:
      provider === "alibaba"
        ? (process.env["ROBO_ALIBABA_URL"] ?? alibaba)
        : "https://api.x.ai/v1",
    includeUsage: true,
    ...(provider === "alibaba" && key ? { apiKey: key } : {}),
    ...(provider === "xai"
      ? {
          fetch: Object.assign(
            async (input: RequestInfo | URL, init?: RequestInit) => {
              const token = await xaiToken();
              if (!token) {
                throw new Error(
                  "xAI credentials expired; refresh using the owning Grok CLI"
                );
              }
              const headers = new Headers(init?.headers);
              headers.set("Authorization", `Bearer ${token}`);
              return fetch(input, { ...init, headers });
            },
            { preconnect: fetch.preconnect }
          ),
        }
      : {}),
  });
  return { model: client(chosen), info: { ...info, model: chosen } };
}
