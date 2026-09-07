import { expect, test } from "bun:test";

import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { runChatLoop } from "./loop";
import { DOOM_LOOP_STOP } from "./stop-conditions";

const nullUsage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

type Chunk = LanguageModelV4StreamPart;

/** A step that calls one tool with `{}` and returns to the loop. */
const toolStep = (toolName: string, id: string): Chunk[] => [
  { type: "stream-start", warnings: [] },
  { type: "tool-call", toolCallId: id, toolName, input: "{}" },
  {
    type: "finish",
    usage: nullUsage,
    finishReason: { unified: "tool-calls", raw: "tool_use" },
  },
];

/** A step that streams `text` and stops. */
const textStep = (text: string): Chunk[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  {
    type: "finish",
    usage: nullUsage,
    finishReason: { unified: "stop", raw: "end_turn" },
  },
];

const scriptedModel = (steps: Chunk[][]): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doStream: steps.map((chunks) => ({
      stream: simulateReadableStream({ chunks }),
    })),
  });

const pingTools = (): ToolSet => ({
  ping: tool({
    description: "ping",
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: () => Promise.resolve({ ok: true }),
  }),
});

const drain = async (
  stream: AsyncIterable<{ type: string; text?: string }>
): Promise<{ types: string[]; text: string }> => {
  const types: string[] = [];
  let text = "";
  for await (const part of stream) {
    types.push(part.type);
    if (part.type === "text-delta" && typeof part.text === "string") {
      text += part.text;
    }
  }
  return { types, text };
};

const noImages = () => [] as ModelMessage[];

const base = (
  model: MockLanguageModelV4,
  over: Partial<Parameters<typeof runChatLoop>[0]> = {}
) =>
  runChatLoop({
    model,
    instructions: "test",
    tools: pingTools(),
    abortSignal: new AbortController().signal,
    history: [{ role: "user", content: "go" }],
    drainSteers: () => [],
    drainImages: noImages,
    onPersist: () => {},
    ...over,
  });

test("a model that repeats the identical tool call is stopped by the doom-loop guard, not run to the step cap", async () => {
  const model = scriptedModel(
    Array.from({ length: 20 }, (_, i) => toolStep("ping", `c${String(i)}`))
  );
  const { types } = await drain(base(model));
  // Five identical call+result steps trip the guard; the sixth call is never made.
  expect(model.doStreamCalls.length).toBe(DOOM_LOOP_STOP);
  expect(types.filter((t) => t === "tool-result").length).toBe(DOOM_LOOP_STOP);
});

test("the first prompt carries the harness bar as its tail", async () => {
  const model = scriptedModel([textStep("hello")]);
  await drain(base(model));
  const call = model.doStreamCalls[0];
  const last = call?.prompt.at(-1);
  const text =
    last?.role === "user" && Array.isArray(last.content)
      ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("")
      : "";
  expect(text).toContain("[harness]");
  expect(text).toContain("step 1/24");
});

test("a steer that arrives after a text-only step starts another round that sees it", async () => {
  // The steer is not present when round 1's prepareStep drains; it lands only
  // on the post-round check (drain call 2), so it can only be answered by a
  // second round — the path this guards.
  let drains = 0;
  const model = scriptedModel([textStep("first"), textStep("done")]);
  const { text } = await drain(
    base(model, {
      drainSteers: () => {
        drains += 1;
        return drains === 2 ? ["keep going"] : [];
      },
    })
  );
  // Two model calls: the first round yielded, the steer forced a second.
  expect(model.doStreamCalls.length).toBe(2);
  expect(text).toBe("firstdone");
  // The steer reached the second call's prompt.
  const second = JSON.stringify(model.doStreamCalls[1]?.prompt);
  expect(second).toContain("keep going");
});
