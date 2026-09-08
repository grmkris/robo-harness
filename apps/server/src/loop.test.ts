import { expect, test } from "bun:test";

import { std } from "@robo/protocol";
import {
  EventType,
  type ModelMessage,
  type StreamChunk,
  type Tool,
} from "@tanstack/ai";
import { Effect, Schema, Stream } from "effect";

import type { ChatAdapter, ChatEvent } from "./chat-stream";
import { runChatLoop } from "./loop";
import { DOOM_LOOP_STOP } from "./stop-conditions";

type RequestOptions = Parameters<ChatAdapter["chatStream"]>[0];
const finished = (finishReason: "stop" | "tool_calls"): StreamChunk => ({
  type: EventType.RUN_FINISHED,
  runId: "fixture",
  threadId: "fixture",
  timestamp: Date.now(),
  metadata: { tanstack: { finishReason } },
});
const toolStep = (name: string, id: string, args = "{}"): StreamChunk[] => [
  {
    type: "TOOL_CALL_START",
    toolCallId: id,
    toolCallName: name,
    timestamp: Date.now(),
  },
  {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: id,
    delta: args,
    timestamp: Date.now(),
  },
  { type: "TOOL_CALL_END", toolCallId: id, timestamp: Date.now() },
  finished("tool_calls"),
];
const textStep = (text: string): StreamChunk[] => [
  {
    type: EventType.TEXT_MESSAGE_START,
    messageId: "text",
    role: "assistant",
    timestamp: Date.now(),
  },
  {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "text",
    delta: text,
    timestamp: Date.now(),
  },
  {
    type: EventType.TEXT_MESSAGE_END,
    messageId: "text",
    timestamp: Date.now(),
  },
  finished("stop"),
];
const scriptedModel = (steps: StreamChunk[][]) => {
  const requests: RequestOptions[] = [];
  const model: ChatAdapter = {
    kind: "text",
    name: "fixture",
    model: "fixture",
    "~types": {
      providerOptions: {},
      inputModalities: ["text", "image"],
      messageMetadataByModality: {
        text: undefined,
        image: undefined,
        audio: undefined,
        video: undefined,
        document: undefined,
      },
      toolCapabilities: [],
      toolCallMetadata: undefined,
      systemPromptMetadata: undefined as never,
    },
    async *chatStream(options) {
      requests.push(options);
      yield* steps[requests.length - 1] ?? textStep("done");
    },
    structuredOutput: async () => ({ data: {}, rawText: "{}" }),
  };
  return { model, requests };
};
const ping = (execute: Tool["execute"] = async () => ({ ok: true })): Tool => ({
  name: "ping",
  description: "ping",
  inputSchema: std(Schema.Struct({})),
  execute,
});
const base = (
  model: ChatAdapter,
  over: Partial<Parameters<typeof runChatLoop>[0]> = {}
) =>
  runChatLoop({
    model,
    instructions: "test",
    tools: [ping()],
    abortSignal: new AbortController().signal,
    history: [{ role: "user", content: "go" }],
    drainSteers: () => [],
    drainImages: () => [],
    onPersist: () => {},
    ...over,
  });
const drain = (stream: ReturnType<typeof runChatLoop>) =>
  Effect.runPromise(Stream.runCollect(stream));
const types = (events: readonly ChatEvent[]) => events.map((part) => part.type);

test("identical tool calls stop at the doom threshold with a reserved summary", async () => {
  const { model, requests } = scriptedModel(
    Array.from({ length: 20 }, (_, i) => toolStep("ping", `c${i}`))
  );
  const events = await drain(base(model));
  expect(requests).toHaveLength(DOOM_LOOP_STOP + 1);
  expect(types(events).filter((type) => type === "tool-result")).toHaveLength(
    DOOM_LOOP_STOP
  );
});
test("harness bar stays in provider context, outside the persisted transcript", async () => {
  const { model, requests } = scriptedModel([
    toolStep("ping", "p"),
    textStep("hello"),
  ]);
  let history: readonly ModelMessage[] = [];
  await drain(
    base(model, {
      onPersist: (messages) => {
        history = messages;
      },
    })
  );
  expect(requests[0]?.messages.at(-1)?.content).toContain("step 1/24");
  expect(JSON.stringify(history)).not.toContain("[harness]");
  expect(history.filter((message) => message.role === "tool")).toHaveLength(1);
  expect(history.at(-1)?.content).toBe("hello");
});
test("execution errors surface as typed error events and model-readable failures", async () => {
  const { model, requests } = scriptedModel([
    toolStep("ping", "p"),
    textStep("recovered"),
  ]);
  const events = await drain(
    base(model, {
      tools: [
        ping(async () => {
          throw new Error("nope");
        }),
      ],
    })
  );
  expect(types(events)).toContain("tool-error");
  expect(types(events)).not.toContain("tool-result");
  expect(JSON.stringify(requests[1]?.messages)).toContain("TOOL_FAILED");
});
test("late steering starts a continuation on the persisted conversation", async () => {
  const { model, requests } = scriptedModel([
    textStep("first"),
    textStep("done"),
  ]);
  let drains = 0;
  await drain(
    base(model, {
      drainSteers: () => {
        drains += 1;
        return drains === 2 ? ["keep going"] : [];
      },
    })
  );
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1]?.messages)).toContain("keep going");
});
test("changing invalid inputs still force a summary after three failures", async () => {
  const { model, requests } = scriptedModel(
    Array.from({ length: 6 }, (_, index) =>
      toolStep(
        "ping",
        `bad-${index}`,
        JSON.stringify({ duration_s: String(index) })
      )
    )
  );
  let executions = 0;
  const events = await drain(
    base(model, {
      tools: [
        {
          ...ping(async () => {
            executions += 1;
          }),
          inputSchema: std(Schema.Struct({ duration_s: Schema.Finite })),
        },
      ],
    })
  );
  expect(executions).toBe(0);
  expect(requests).toHaveLength(4);
  expect(requests[3]?.modelOptions?.["tool_choice"]).toBe("none");
  expect(events.filter((event) => event.type === "tool-error")).toHaveLength(3);
});
test("summary disables execution even if provider ignores tool_choice", async () => {
  const { model, requests } = scriptedModel([toolStep("ping", "last")]);
  let executions = 0;
  await drain(
    base(model, {
      stepCap: 1,
      tools: [
        ping(async () => {
          executions += 1;
        }),
      ],
    })
  );
  expect(executions).toBe(0);
  expect(requests[0]?.modelOptions?.["tool_choice"]).toBe("none");
});
test("steering continuations share the total step budget", async () => {
  const { model, requests } = scriptedModel(
    Array.from({ length: 10 }, () => textStep("answer"))
  );
  let drains = 0;
  await drain(
    base(model, {
      stepCap: 3,
      drainSteers: () => {
        drains += 1;
        return drains % 2 === 0 ? ["continue"] : [];
      },
    })
  );
  expect(requests).toHaveLength(3);
});
test("a long tool is outside the provider stall deadline", async () => {
  const { model } = scriptedModel([toolStep("ping", "slow"), textStep("done")]);
  const events = await drain(
    base(model, {
      stall: { firstChunkMs: 25, chunkMs: 25 },
      tools: [
        ping(async () => {
          await Bun.sleep(90);
          return { ok: true };
        }),
      ],
    })
  );
  expect(types(events)).toContain("tool-result");
});
test("provider stall before headers and mid-stream abort the request and finalize", async () => {
  for (const mid of [false, true]) {
    const { model } = scriptedModel([]);
    let closed = false;
    let aborted = false;
    model.chatStream = async function* chatStream(options) {
      const signal =
        options.request instanceof Request
          ? options.request.signal
          : options.request?.signal;
      try {
        if (mid) yield textStep("partial")[0]!;
        const wait = Promise.withResolvers<null>();
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            wait.resolve(null);
          },
          { once: true }
        );
        await wait.promise;
      } finally {
        closed = true;
      }
    };
    const result = await drain(
      base(model, { stall: { firstChunkMs: 20, chunkMs: 20 } })
    ).catch(() => "stalled");
    expect(result).toBe("stalled");
    expect(aborted).toBe(true);
    expect(closed).toBe(true);
  }
});
test("cancel during a tool blocks the next tool and waits for cleanup", async () => {
  const { model } = scriptedModel([
    [...toolStep("ping", "first").slice(0, -1), ...toolStep("ping", "second")],
  ]);
  const controller = new AbortController();
  let executions = 0;
  let cleaned = false;
  await drain(
    base(model, {
      abortSignal: controller.signal,
      tools: [
        ping(async () => {
          executions += 1;
          controller.abort();
          await Bun.sleep(30);
          cleaned = true;
          return { ok: true };
        }),
      ],
    })
  ).catch(() => {});
  expect(executions).toBe(1);
  expect(cleaned).toBe(true);
});
test("malformed argument primitives cannot become an empty-object tool call", async () => {
  const { model } = scriptedModel([
    toolStep("ping", "primitive", "null"),
    textStep("done"),
  ]);
  let executions = 0;
  await drain(
    base(model, {
      tools: [
        ping(async () => {
          executions += 1;
        }),
      ],
    })
  );
  expect(executions).toBe(0);
});

test("Effect tuple schemas reach the adapter with exactly three numeric coordinates", async () => {
  const { model, requests } = scriptedModel([textStep("done")]);
  await drain(
    base(model, {
      tools: [
        {
          ...ping(),
          inputSchema: std(
            Schema.Struct({
              xyz: Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite]),
            })
          ),
        },
      ],
    })
  );
  expect(requests[0]?.tools?.[0]?.inputSchema).toMatchObject({
    type: "object",
    properties: {
      xyz: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: [{ type: "number" }, { type: "number" }, { type: "number" }],
      },
    },
  });
});

test("leaving the Effect stream early aborts and closes the provider iterator", async () => {
  const { model } = scriptedModel([]);
  let aborted = false;
  let closed = false;
  model.chatStream = async function* chatStream(options) {
    const signal =
      options.request instanceof Request
        ? options.request.signal
        : options.request?.signal;
    signal?.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true }
    );
    try {
      yield* textStep("hello");
    } finally {
      closed = true;
    }
  };
  await Effect.runPromise(Stream.runCollect(base(model).pipe(Stream.take(1))));
  expect(aborted).toBe(true);
  expect(closed).toBe(true);
});
