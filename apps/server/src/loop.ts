import {
  chat,
  EventType,
  isStandardSchema,
  parseWithStandardSchema,
  maxIterations,
  type ChatMiddleware,
  type ModelMessage,
  type Tool,
} from "@tanstack/ai";
import { Schema } from "effect";

import { closePendingCalls } from "./chat-history";
import {
  scopedChatStream,
  type ChatAdapter,
  type ChatEvent,
} from "./chat-stream";
import { MAX_OUTPUT_TOKENS, STEP_CAP, STREAM_STALL } from "./limits";
import { stallWatchdog } from "./stall-watchdog";
import type { StallLimits } from "./stall-watchdog";
import {
  CHURN_NUDGE,
  DOOM_LOOP_NUDGE,
  DOOM_LOOP_STOP,
  CYCLE_WINDOW,
  isCycleLoop,
  isDoomLoop,
  failedActionSteps,
  resultChurn,
  trailingRepeat,
} from "./stop-conditions";
import { describeToolError, ToolFailure } from "./tool-errors";

/** A round that ends without a tool call yields to the operator. It runs
 *  again only when a steer arrived after the model stopped calling tools;
 *  this caps how many such continuations one turn may take. */
const MAX_STEER_ROUNDS = 8;
/** The harness bar is the tail of every prompt, replaced each step (found by
 *  this marker, never stacked), so the bytes before it stay a stable prefix. */
const HARNESS_MARK = "[harness]";

export interface ChatLoopOptions {
  readonly model: ChatAdapter;
  readonly instructions: string;
  readonly tools: Tool[];
  readonly abortSignal: AbortSignal;
  /** The turn's starting transcript: prior history plus the new user text,
   *  already appended by the host. The loop owns it from here. */
  readonly history: readonly ModelMessage[];
  /** Steers queued since the last drain, inlined as numbered user messages. */
  readonly drainSteers: () => readonly string[];
  readonly steerRevision?: () => number;
  readonly runtimeContext?: () => string;
  /** Camera frames captured since the last drain, as user messages carrying
   *  the image part — injected before the next step so a vision model sees
   *  them (OpenAI-compatible providers reject media in tool results, so the
   *  frame rides a user message, not the tool output). Persisted too. */
  readonly drainImages: () => readonly ModelMessage[];
  /** Called with the full transcript whenever it grows, so the host can
   *  persist incrementally and strip images from what it stores. */
  readonly onPersist: (transcript: readonly ModelMessage[]) => void;
  readonly prepareTools?: (
    stepNumber: number,
    summaryOnly: boolean
  ) => string[];
  readonly modelOptions?: Record<string, unknown>;
  readonly stepCap?: number | undefined;
  readonly stall?: StallLimits | undefined;
}

const isBar = (message: ModelMessage): boolean =>
  message.role === "user" &&
  typeof message.content === "string" &&
  message.content.startsWith(HARNESS_MARK);
/** Strip the previous step's bar and append this step's, so it is replaced
 *  rather than stacked. */
const withHarnessBar = (
  messages: readonly ModelMessage[],
  bar: string
): ModelMessage[] => [
  ...messages.filter((message) => !isBar(message)),
  { role: "user", content: bar },
];
/** Keep the wire prompt bounded by dropping whole user-delimited turns from
 *  the front, so tool-call/result pairs are never split. */
const TRANSCRIPT_CHAR_CAP = 100_000;
const trim = (messages: readonly ModelMessage[]): ModelMessage[] => {
  let kept = [...messages];
  let total = JSON.stringify(kept).length;
  while (total > TRANSCRIPT_CHAR_CAP && kept.length > 4) {
    const next = kept.findIndex((m, i) => i > 0 && m.role === "user");
    if (next < 1) {
      break;
    }
    kept = kept.slice(next);
    total = JSON.stringify(kept).length;
  }
  return kept;
};
const steerMessages = (steers: readonly string[]): ModelMessage[] =>
  steers.map((text, index) => ({
    role: "user" as const,
    content:
      steers.length === 1
        ? `Operator steering: ${text}`
        : `Operator steering [${String(index + 1)}/${String(steers.length)}]: ${text}`,
  }));

interface StepLike {
  readonly toolCalls?: readonly { toolName: string; input: unknown }[];
  readonly toolResults?: readonly { toolName: string; output: unknown }[];
  readonly content?: readonly { type: string; error?: unknown }[];
}

/** The status line the model reads about its own turn: step budget, and the
 *  repeat/churn nudges the stop conditions are about to enforce. */
const renderBar = (
  stepNumber: number,
  stepCap: number,
  steps: readonly StepLike[],
  pendingSteers: number
): string => {
  const lines = [`step ${String(stepNumber + 1)}/${String(stepCap)}`],
    repeat = trailingRepeat(steps);
  if (repeat !== null && repeat.count >= DOOM_LOOP_NUDGE) {
    lines.push(
      `repeats: you made the same tool call ${String(repeat.count)} times in a row with identical arguments. The turn ends at ×${String(DOOM_LOOP_STOP)} identical call+result. Use different arguments, choose another tool, or say what you have and stop.`
    );
  }
  const churn = resultChurn(steps);
  if (churn !== null && churn.count >= CHURN_NUDGE) {
    lines.push(
      `same answer: your last ${String(churn.count)} steps used ${String(churn.distinctCalls)} different arguments and every one returned the same result. If you are looking for something it is not there; say so and stop, or try another approach. The turn ends if the last ${String(CYCLE_WINDOW)} steps cycle between two states.`
    );
  }
  if (pendingSteers > 1) {
    lines.push(
      `pending steers: ${String(pendingSteers)} (delivered above as separate instructions; cover all of them)`
    );
  }
  if (stepNumber >= stepCap - 1) {
    lines.push(
      `LAST STEP: this is step ${String(stepCap)} of ${String(stepCap)}. Tools are disabled for this final summary. State what is done, what you observed, and what remains.`
    );
  }
  return `${HARNESS_MARK}\n${lines.join("\n")}`;
};

/** TanStack owns the agentic cycle; Effect owns its resource lifetime. */
export const runChatLoop = (opts: ChatLoopOptions) =>
  scopedChatStream(
    (controller) => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<ChatEvent> {
        const stepCap = opts.stepCap ?? STEP_CAP;
        const adapter = stallWatchdog(opts.model, opts.stall ?? STREAM_STALL);
        let transcript = [...opts.history];
        const completedSteps: StepLike[] = [];
        let totalSteps = 0;
        let summaryOnly = false;
        let stepOpen = false;
        const queue: ChatEvent[] = [];
        const calls = new Map<string, { name: string; args: string }>();
        const parseArgs = (args: string): unknown => {
          try {
            return JSON.parse(args);
          } catch {
            return args;
          }
        };
        const finishStep = () => {
          if (stepOpen) {
            queue.push({ type: "finish-step" });
            totalSteps += 1;
            stepOpen = false;
          }
        };
        const snapshot = (messages: readonly ModelMessage[]) => {
          transcript = [...messages];
          opts.onPersist(transcript);
        };
        let allowed = new Set<string>();
        let plannedRevision = opts.steerRevision?.() ?? 0;
        const guardedTools = opts.tools.map((definition): Tool => ({
          ...definition,
          execute: async (input: unknown, context) => {
            controller.signal.throwIfAborted();
            if (
              definition.name !== "stop" &&
              plannedRevision !== (opts.steerRevision?.() ?? 0)
            )
              throw new ToolFailure({
                code: "OPERATOR_STEERED",
                detail:
                  "The operator changed the instruction while this response was being generated. This tool was not executed. Read the new instruction before acting.",
              });
            if (summaryOnly || !allowed.has(definition.name))
              throw new ToolFailure({
                code: "TOOL_NOT_AVAILABLE",
                detail:
                  "Tools are disabled for this step. Summarize the measured outcome.",
              });
            const output: unknown = await definition.execute?.(input, context);
            return output;
          },
        }));
        const middleware: ChatMiddleware = {
          name: "robo-harness",
          onConfig: (ctx, config) => {
            if (ctx.phase !== "beforeModel") return;
            controller.signal.throwIfAborted();
            finishStep();
            snapshot(config.messages);
            summaryOnly =
              totalSteps >= stepCap - 1 ||
              isDoomLoop(completedSteps) ||
              isCycleLoop(completedSteps) ||
              failedActionSteps(completedSteps) >= 3;
            allowed = new Set(
              opts.prepareTools?.(totalSteps, summaryOnly) ??
                (summaryOnly ? [] : guardedTools.map((t) => t.name))
            );
            const steers = opts.drainSteers();
            plannedRevision = opts.steerRevision?.() ?? 0;
            const messages = [
              ...config.messages,
              ...opts.drainImages(),
              ...steerMessages(steers),
            ];
            snapshot(messages);
            stepOpen = true;
            queue.push({ type: "start-step" });
            return {
              messages,
              providerMessages: withHarnessBar(
                trim(messages),
                renderBar(totalSteps, stepCap, completedSteps, steers.length) +
                  (opts.runtimeContext ? `\n${opts.runtimeContext()}` : "") +
                  (summaryOnly
                    ? "\nTools are disabled. Explain the measured outcome or recurring failure; do not claim an unfinished action succeeded."
                    : "")
              ),
              tools: guardedTools.filter((t) => allowed.has(t.name)),
              modelOptions: {
                ...opts.modelOptions,
                max_tokens: MAX_OUTPUT_TOKENS,
                ...(summaryOnly ? { tool_choice: "none" } : {}),
              },
            };
          },
          onBeforeToolCall: (_ctx, info) => {
            if (controller.signal.aborted)
              return {
                type: "skip",
                result: { error: "CANCELLED: Operator stopped this run." },
              };
            // The compatible adapter removes optional nulls before dispatch.
            // Validate the original deltas, not its normalized TOOL_CALL_END.
            try {
              const raw = Schema.decodeUnknownSync(
                Schema.Record(Schema.String, Schema.Unknown)
              )(
                JSON.parse(
                  calls.get(info.toolCallId)?.args ??
                    info.toolCall.function.arguments
                )
              );
              const schema = guardedTools.find(
                (tool) => tool.name === info.toolName
              )?.inputSchema;
              const input = isStandardSchema(schema)
                ? parseWithStandardSchema<unknown>(schema, raw)
                : raw;
              return { type: "transformArgs", args: input };
            } catch (error) {
              const failure = describeToolError(
                `Input validation failed: ${error instanceof Error ? error.message : "Invalid JSON object"}`
              );
              return {
                type: "skip",
                result: { error: `${failure.code}: ${failure.message}` },
              };
            }
          },
          onChunk: (_ctx, chunk) => {
            if (chunk.type === EventType.TEXT_MESSAGE_CONTENT)
              queue.push({ type: "text-delta", text: chunk.delta });
            if (chunk.type === "TOOL_CALL_START")
              calls.set(chunk.toolCallId, {
                name: chunk.toolCallName,
                args: "",
              });
            if (chunk.type === EventType.TOOL_CALL_ARGS) {
              const call = calls.get(chunk.toolCallId);
              if (call) call.args += chunk.delta;
            }
            if (chunk.type === "TOOL_CALL_END") {
              const call = calls.get(chunk.toolCallId);
              if (call)
                queue.push({
                  type: "tool-call",
                  toolCallId: chunk.toolCallId,
                  toolName: call.name,
                  input: parseArgs(call.args),
                });
            }
            if (chunk.type === EventType.RUN_ERROR)
              throw new Error("Provider stream failed");
          },
          onToolPhaseComplete: (_ctx, info) => {
            const content: { type: string; error?: unknown }[] = [];
            const results = info.results.map((result) => {
              // The aggregate includes validation errors that bypass execution hooks.
              const failure = Schema.decodeUnknownOption(
                Schema.Struct({ error: Schema.String })
              )(result.result);
              if (failure._tag === "Some") {
                const described = describeToolError(failure.value.error);
                const error = `${described.code}: ${described.message}`;
                result.result = { error };
                content.push({ type: "tool-error", error });
                queue.push({
                  type: "tool-error",
                  toolCallId: result.toolCallId,
                  toolName: result.toolName,
                  error,
                });
              } else
                queue.push({
                  type: "tool-result",
                  toolCallId: result.toolCallId,
                  toolName: result.toolName,
                  output: result.result,
                });
              return { toolName: result.toolName, output: result.result };
            });
            completedSteps.push({
              toolCalls: info.toolCalls.map((call) => ({
                toolName: call.function.name,
                input: parseArgs(call.function.arguments),
              })),
              toolResults: results,
              content,
            });
          },
          onShouldContinue: (_ctx, state) =>
            state.iterationCount === 0 ||
            (!summaryOnly && totalSteps + 1 < stepCap),
          onFinish: (ctx) => {
            snapshot(ctx.messages);
            finishStep();
          },
          onAbort: (ctx) => {
            snapshot(closePendingCalls(ctx.messages));
            finishStep();
          },
          onError: (ctx) => {
            snapshot(closePendingCalls(ctx.messages));
            finishStep();
          },
        };
        for (let round = 0; round < MAX_STEER_ROUNDS; round += 1) {
          const stream = chat({
            debug: false,
            adapter,
            messages: transcript,
            systemPrompts: [opts.instructions],
            tools: guardedTools,
            middleware: [middleware],
            abortController: controller,
            agentLoopStrategy: maxIterations(Math.max(1, stepCap - totalSteps)),
          });
          for await (const _chunk of stream) {
            yield* queue.splice(0);
          }
          yield* queue.splice(0);
          controller.signal.throwIfAborted();
          if (summaryOnly || totalSteps >= stepCap) break;
          const steers = opts.drainSteers();
          if (steers.length === 0) break;
          transcript.push(...steerMessages(steers));
          opts.onPersist(transcript);
        }
      },
    }),
    opts.abortSignal
  );
