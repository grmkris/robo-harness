#!/usr/bin/env bun
/**
 * Probe what each cliproxy model alias can actually do, straight at the proxy
 * (not through the coordinator), before a benchmark trusts it.
 *
 *   bun run probe-models gpt-6-astra grok-4.7 claude-opus-5-5 qwen3.8-max [--json]
 *
 * Per model, three small chat-completions requests:
 *   tool  -- one function tool the prompt says to call; ok when it is called
 *   image -- a 32x32 PNG data URL with a red square; ok when the answer says red
 *   ptc   -- the tool request again with parallel_tool_calls:false; ok when the
 *            upstream accepts the field (HTTP 200) and still calls the tool
 * Prints a table (or --json), with latency, token usage and error text.
 *
 * Environment: ROBO_CLIPROXY_URL (default http://127.0.0.1:8317/v1); the key
 * is ROBO_CLIPROXY_KEY, CLIPROXY_API_KEY_ROBO or CLIPROXY_API_KEY. Credentials
 * must be explicitly exported by the operator. The key is never printed.
 */
import { parseArgs } from "node:util";

import { redSquarePng } from "./probe-image";

const { values: flags, positionals: models } = parseArgs({
  options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  allowPositionals: true,
  strict: true,
});

const baseUrl = process.env["ROBO_CLIPROXY_URL"] ?? "http://127.0.0.1:8317/v1";

const proxyKey = (): string => {
  const direct =
    process.env["ROBO_CLIPROXY_KEY"] ??
    process.env["CLIPROXY_API_KEY_ROBO"] ??
    process.env["CLIPROXY_API_KEY"];
  if (direct) return direct;
  throw new Error("No cliproxy key: set ROBO_CLIPROXY_KEY");
};

const tool = {
  type: "function",
  function: {
    name: "report_number",
    description: "Report the number the user asked for.",
    parameters: {
      type: "object",
      properties: { value: { type: "integer" } },
      required: ["value"],
    },
  },
};

interface Attempt {
  ok: boolean;
  latency_ms: number;
  detail: string;
  input_tokens: number | null;
  output_tokens: number | null;
}

const complete = async (
  key: string,
  body: Record<string, unknown>,
  judge: (message: Record<string, unknown>) => { ok: boolean; detail: string }
): Promise<Attempt> => {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, max_tokens: 2048 }),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    const latency = Math.round(performance.now() - started);
    if (!response.ok) {
      return {
        ok: false,
        latency_ms: latency,
        detail: `HTTP ${String(response.status)}: ${text.slice(0, 200)}`,
        input_tokens: null,
        output_tokens: null,
      };
    }
    const data = JSON.parse(text) as {
      choices?: { message?: Record<string, unknown> }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const verdict = judge(data.choices?.[0]?.message ?? {});
    return {
      ...verdict,
      latency_ms: latency,
      input_tokens: data.usage?.prompt_tokens ?? null,
      output_tokens: data.usage?.completion_tokens ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      latency_ms: Math.round(performance.now() - started),
      detail: error instanceof Error ? error.message : String(error),
      input_tokens: null,
      output_tokens: null,
    };
  }
};

const judgeTool = (message: Record<string, unknown>) => {
  const calls = (message["tool_calls"] ?? []) as {
    function?: { name?: string; arguments?: string };
  }[];
  const call = calls.find((entry) => entry.function?.name === "report_number");
  return call
    ? {
        ok: true,
        detail: `${String(calls.length)} call(s): ${call.function?.arguments ?? ""}`,
      }
    : {
        ok: false,
        detail: `no tool call; said: ${String(message["content"] ?? "").slice(0, 120)}`,
      };
};

const probe = async (key: string, model: string, image: string) => {
  const toolRequest = {
    model,
    messages: [
      {
        role: "user",
        content:
          "Call the report_number tool with value 7. Do not answer in text.",
      },
    ],
    tools: [tool],
  };
  const [toolCall, vision, parallelFlag] = await Promise.all([
    complete(key, toolRequest, judgeTool),
    complete(
      key,
      {
        model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "What colour is the square in this image? Answer with one word.",
              },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
      },
      (message) => {
        const answer = String(message["content"] ?? "").trim();
        return { ok: /\bred\b/iu.test(answer), detail: answer.slice(0, 80) };
      }
    ),
    complete(key, { ...toolRequest, parallel_tool_calls: false }, judgeTool),
  ]);
  return {
    model,
    tool_call_ok: toolCall.ok,
    image_ok: vision.ok,
    parallel_tool_calls_false_ok: parallelFlag.ok,
    tool: toolCall,
    image: vision,
    parallel_tool_calls_false: parallelFlag,
  };
};

const main = async () => {
  if (flags.help || models.length === 0) {
    const source = await Bun.file(import.meta.path).text();
    console.error(
      (source.split("*/")[0] ?? "")
        .replace(/^#!.*\n\/\*\*\n/u, "")
        .replaceAll(/^ \* ?/gmu, "")
    );
    process.exitCode = flags.help ? 0 : 2;
    return;
  }
  const key = proxyKey();
  const image = `data:image/png;base64,${Buffer.from(redSquarePng()).toString("base64")}`;
  const results = await Promise.all(
    models.map((model) => probe(key, model, image))
  );
  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  const mark = (ok: boolean) => (ok ? "yes" : "NO");
  console.log(
    "| model | tool_call_ok | image_ok | ptc:false ok | latency tool/image/ptc ms | image answer | errors |"
  );
  console.log("|---|---|---|---|---|---|---|");
  for (const result of results) {
    const errors = [result.tool, result.image, result.parallel_tool_calls_false]
      .filter((attempt) => !attempt.ok)
      .map((attempt) =>
        attempt.detail.replaceAll("|", "/").replaceAll("\n", " ")
      )
      .join("; ");
    console.log(
      `| ${result.model} | ${mark(result.tool_call_ok)} | ${mark(result.image_ok)} | ${mark(result.parallel_tool_calls_false_ok)} | ${String(result.tool.latency_ms)}/${String(result.image.latency_ms)}/${String(result.parallel_tool_calls_false.latency_ms)} | ${result.image.detail.replaceAll("\n", " ")} | ${errors || "-"} |`
    );
  }
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
