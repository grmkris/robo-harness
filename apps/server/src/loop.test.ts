import { expect, test } from "bun:test";

import { std } from "@robo/protocol";
import {
  EventType,
  type ModelMessage,
  type StreamChunk,
  type Tool,
} from "@tanstack/ai";
import { Effect, Schema, Stream } from "effect";
import OpenAI from "openai";

import type { ChatAdapter, ChatEvent } from "./chat-stream";
import { runChatLoop } from "./loop";
import { RobotChatAdapter } from "./provider-adapter";
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
    const result = await Effect.runPromise(
      Stream.runCollect(
        base(model, { stall: { firstChunkMs: 20, chunkMs: 20 } })
      ).pipe(
        Effect.catchTag("ChatRunError", (error) => Effect.succeed(error.code))
      )
    );
    expect(result).toBe("PROVIDER_TIMEOUT");
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

test("steering during generation skips the stale tool and replans", async () => {
  const { model, requests } = scriptedModel([]);
  let revision = 0;
  const steers: string[] = [];
  let executions = 0;
  model.chatStream = async function* chatStream(options) {
    requests.push(options);
    if (requests.length === 1) {
      yield* toolStep("ping", "old").slice(0, 2);
      revision += 1;
      steers.push("pick up the white piece");
      yield* toolStep("ping", "old").slice(2);
    } else if (requests.length === 2) {
      yield* toolStep("ping", "new");
    } else yield* textStep("done");
  };
  const events = await drain(
    base(model, {
      steerRevision: () => revision,
      drainSteers: () => steers.splice(0),
      tools: [
        ping(async () => {
          executions += 1;
          return { ok: true };
        }),
      ],
    })
  );
  expect(executions).toBe(1);
  expect(JSON.stringify(requests[1]?.messages)).toContain(
    "pick up the white piece"
  );
  expect(JSON.stringify(events)).toContain("OPERATOR_STEERED");
});

test("Qwen reasoning-only chunks keep the stream alive until text arrives", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (
              delta: Record<string, unknown>,
              finish_reason: string | null = null
            ) =>
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ id: "reasoning", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
                )
              );
            for (let i = 0; i < 8; i += 1) {
              send({ reasoning_content: "private fixture reasoning" });
              await Bun.sleep(40);
            }
            send({ content: "Visible answer." });
            send({}, "stop");
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      );
    },
  });
  try {
    const client = new OpenAI({
      apiKey: "fixture-not-a-secret",
      baseURL: `http://127.0.0.1:${server.port}`,
      maxRetries: 0,
    });
    const model = new RobotChatAdapter(client, "fixture", "alibaba");
    const events = await drain(
      base(model, { stall: { firstChunkMs: 150, chunkMs: 150 } })
    );
    expect(events).toContainEqual({ type: "model-status", status: "thinking" });
    expect(events).toContainEqual({
      type: "text-delta",
      text: "Visible answer.",
    });
    expect(JSON.stringify(events)).not.toContain("private fixture reasoning");
  } finally {
    await server.stop(true);
  }
});

test("each model call's reported usage becomes one usage event", async () => {
  const { model } = scriptedModel([
    [
      ...toolStep("ping", "u").slice(0, -1),
      {
        ...finished("tool_calls"),
        usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
      },
    ],
    [
      ...textStep("done").slice(0, -1),
      {
        ...finished("stop"),
        usage: {
          promptTokens: 200,
          completionTokens: 5,
          totalTokens: 205,
          cost: 0.002,
        },
      },
    ],
  ]);
  const events = await drain(base(model));
  expect(events.filter((part) => part.type === "usage")).toEqual([
    { type: "usage", input_tokens: 120, output_tokens: 30 },
    { type: "usage", input_tokens: 200, output_tokens: 5, cost: 0.002 },
  ]);
});
