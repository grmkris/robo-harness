import { readFile } from "node:fs/promises";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import type { ProviderInfo } from "../shared/contracts";
import { ApiError } from "./robot";
const alibaba =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
async function xaiToken() {
  if (process.env["XAI_API_KEY"]) return process.env["XAI_API_KEY"];
  const path = process.env["ROBO_XAI_AUTH_FILE"];
  if (!path) return null;
  try {
    const file = JSON.parse(await readFile(path, "utf8"));
    const record = Object.entries(file).find(([key]) =>
      key.startsWith("https://auth.x.ai::")
    )?.[1] as { key?: string; expires_at?: string | number } | undefined;
    if (!record?.key) return null;
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
    if (!Number.isFinite(ms) || ms < Date.now() + 60000) return null;
    return record.key;
  } catch {
    return null;
  }
}
export async function catalog(): Promise<ProviderInfo[]> {
  const xai = Boolean(await xaiToken());
  return [
    {
      id: "alibaba",
      name: "Alibaba Token Plan",
      available: Boolean(process.env["DASHSCOPE_API_KEY"]),
      model: process.env["ROBO_ALIBABA_MODEL"] ?? "qwen3.8-max",
      vision: process.env["ROBO_ALIBABA_VISION"] === "1",
      ...(process.env["DASHSCOPE_API_KEY"]
        ? {}
        : { reason: "Set DASHSCOPE_API_KEY" }),
    },
    {
      id: "xai",
      name: "xAI / Grok",
      available: xai,
      model: process.env["ROBO_XAI_MODEL"] ?? "grok-4.6",
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
      vision: true,
      reason: "Direct subscription adapter pending verification",
    },
    {
      id: "codex",
      name: "Codex",
      available: false,
      model: "",
      vision: true,
      reason: "Direct subscription adapter pending verification",
    },
  ];
}
export async function resolveModel(provider: string) {
  const info = (await catalog()).find((p) => p.id === provider);
  if (!info?.available)
    throw new ApiError(info?.reason ?? "Unknown provider", 422);
  const client = createOpenAICompatible({
    name: provider,
    baseURL:
      provider === "alibaba"
        ? (process.env["ROBO_ALIBABA_URL"] ?? alibaba)
        : "https://api.x.ai/v1",
    includeUsage: true,
    ...(provider === "alibaba" && process.env["DASHSCOPE_API_KEY"]
      ? { apiKey: process.env["DASHSCOPE_API_KEY"] }
      : {}),
    ...(provider === "xai"
      ? {
          fetch: Object.assign(
            async (input: RequestInfo | URL, init?: RequestInit) => {
              const token = await xaiToken();
              if (!token)
                throw new Error(
                  "xAI credentials expired; refresh using the owning Grok CLI"
                );
              const headers = new Headers(init?.headers);
              headers.set("Authorization", "Bearer " + token);
              return fetch(input, { ...init, headers });
            },
            { preconnect: fetch.preconnect }
          ),
        }
      : {}),
  });
  return { model: client(info.model), info };
}
