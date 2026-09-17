import type { Frame } from "@robo/domain";
import { Schema } from "effect";

import type { Detection } from "./state";

/** Structured System-2 description of the scene; Jev reads it as text. */
const Scene = Schema.Struct({
  piece_visible_workspace: Schema.Boolean,
  piece_visible_wrist: Schema.Boolean,
  gripper_open: Schema.NullOr(Schema.Boolean),
  piece_between_jaws: Schema.Boolean,
  piece_lifted: Schema.Boolean,
  piece_point_wrist: Schema.NullOr(
    Schema.Tuple([Schema.Finite, Schema.Finite])
  ),
  suggested_subgoal: Schema.Literals([
    "center",
    "descend",
    "open",
    "close",
    "lift",
    "reobserve",
    "done",
    "stop",
  ]),
  confidence: Schema.Literals(["low", "medium", "high"]),
  notes: Schema.String.check(Schema.isMaxLength(300)),
});

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface SceneConfig {
  readonly url: string;
  readonly key: string;
  readonly model: string;
  readonly timeoutMs: number;
}

/** OpenAI-compatible endpoint (cliproxy by default); unavailable without a key. */
export const sceneConfig = (model?: string): SceneConfig | null => {
  const key =
    process.env["ROBO_SCENE_API_KEY"] ?? process.env["CLIPROXY_API_KEY"];
  if (!key) return null;
  return {
    url:
      process.env["ROBO_SCENE_URL"] ??
      "http://127.0.0.1:8317/v1/chat/completions",
    key,
    model: model ?? process.env["ROBO_SCENE_MODEL"] ?? "gemini-3.8-flash",
    timeoutMs: 30_000,
  };
};

const PROMPT = `You look at two camera frames of an SO-101 robot arm on a black mat: first the fixed workspace camera, then the wrist camera mounted by the gripper. The task is to pick up the small white piece.
Answer ONLY with one JSON object with exactly these keys:
{"piece_visible_workspace": boolean, "piece_visible_wrist": boolean, "gripper_open": boolean|null, "piece_between_jaws": boolean, "piece_lifted": boolean, "piece_point_wrist": [x, y]|null, "suggested_subgoal": "center"|"descend"|"open"|"close"|"lift"|"reobserve"|"done"|"stop", "confidence": "low"|"medium"|"high", "notes": string}
piece_point_wrist is the piece centre in the wrist image, normalised 0..1 from the top-left. Be literal; do not guess what you cannot see.`;

interface ChatResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown };
  }[];
}

const extractJson = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start)
    throw new Error("no JSON object in the reply");
  return JSON.parse(text.slice(start, end + 1));
};

export const describeScene = async (
  config: SceneConfig,
  frames: readonly Frame[],
  signal: AbortSignal,
  fetcher: Fetcher = fetch
): Promise<Detection> => {
  const started = performance.now();
  const base = {
    source: `scene/${config.model}`,
    camera: frames.map((frame) => frame.camera).join("+"),
    frame_age_ms: Math.max(...frames.map((frame) => Math.round(frame.age_ms))),
  };
  try {
    const response = await fetcher(config.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              ...frames.map((frame) => ({
                type: "image_url",
                image_url: {
                  url: `data:${frame.media_type};base64,${frame.base64}`,
                },
              })),
            ],
          },
        ],
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as ChatResponse;
    const content = body.choices?.[0]?.message?.content;
    const scene = Schema.decodeUnknownSync(Scene)(
      extractJson(typeof content === "string" ? content : "")
    );
    return {
      ...base,
      ok: true,
      latency_ms: Math.round(performance.now() - started),
      ...scene,
    };
  } catch (error) {
    // Provider errors can echo request details; keep only a short class of failure.
    const message =
      error instanceof Error
        ? error.message.split("\n")[0]?.slice(0, 120)
        : "failed";
    return {
      ...base,
      ok: false,
      latency_ms: Math.round(performance.now() - started),
      error: message ?? "failed",
    };
  }
};
