import {
  isStepCount,
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
} from "ai";

import { MAX_OUTPUT_TOKENS, STEP_CAP, STREAM_STALL } from "./limits";
import { stallWatchdog, type StallLimits } from "./stall-watchdog";
import {
  CHURN_NUDGE,
  DOOM_LOOP_NUDGE,
  DOOM_LOOP_STOP,
  CYCLE_WINDOW,
  noCycleLoop,
  noDoomLoop,
  resultChurn,
  trailingRepeat,
} from "./stop-conditions";

/** A resolved model OBJECT, as `wrapLanguageModel` accepts it — a bare id
 *  (the other arm of the SDK's `LanguageModel` union) would route through the
 *  gateway, so the type refuses one. */
type ModelObject = Parameters<typeof wrapLanguageModel>[0]["model"];

/** A round that ends without a tool call yields to the operator. It runs
 *  again only when a steer arrived after the model stopped calling tools;
 *  this caps how many such continuations one turn may take. */
const MAX_STEER_ROUNDS = 8;

/** The harness bar is the tail of every prompt, replaced each step (found by
 *  this marker, never stacked), so the bytes before it stay a stable prefix. */
const HARNESS_MARK = "[harness]";

export interface ChatLoopOptions {
  readonly model: ModelObject;
  readonly instructions: string;
  readonly tools: ToolSet;
  readonly abortSignal: AbortSignal;
  /** The turn's starting transcript: prior history plus the new user text,
   *  already appended by the host. The loop owns it from here. */
  readonly history: readonly ModelMessage[];
  /** Steers queued since the last drain, inlined as numbered user messages. */
  readonly drainSteers: () => readonly string[];
  /** Camera frames captured since the last drain, as user messages carrying
   *  the image part — injected before the next step so a vision model sees
   *  them (OpenAI-compatible providers reject media in tool results, so the
   *  frame rides a user message, not the tool output). Persisted too. */
  readonly drainImages: () => readonly ModelMessage[];
  /** Called with the full transcript whenever it grows, so the host can
   *  persist incrementally and strip images from what it stores. */
  readonly onPersist: (transcript: readonly ModelMessage[]) => void;
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
}

/** The status line the model reads about its own turn: step budget, and the
 *  repeat/churn nudges the stop conditions are about to enforce. */
const renderBar = (
  stepNumber: number,
  stepCap: number,
  steps: readonly StepLike[],
  pendingSteers: number
): string => {
  const lines = [`step ${String(stepNumber + 1)}/${String(stepCap)}`];
  const repeat = trailingRepeat(steps);
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
      `LAST STEP: this is step ${String(stepCap)} of ${String(stepCap)}. Do not call tools — a call made now runs but you will not see its result. State what is done, what you observed, and what remains.`
    );
  }
  return `${HARNESS_MARK}\n${lines.join("\n")}`;
};

/**
 * One chat turn on the SDK's step loop: a single `streamText` with the step
 * cap and the loop guards as `stopWhen`, a stall watchdog over the raw
 * provider stream, and a `prepareStep` that injects captured frames, drains
 * steers and appends the harness bar. Wrapped in a thin rounds loop so a
 * steer that arrives after the model stopped calling tools starts another
 * round on the conversation so far.
 */
export const runChatLoop = (
  opts: ChatLoopOptions
): AsyncIterable<TextStreamPart<ToolSet>> => {
  const stepCap = opts.stepCap ?? STEP_CAP;
  const model = wrapLanguageModel({
    model: opts.model,
    middleware: [stallWatchdog(opts.stall ?? STREAM_STALL)],
  });
  const transcript: ModelMessage[] = [...opts.history];

  const runRound = (): AsyncIterable<TextStreamPart<ToolSet>> => {
    const result = streamText({
      model,
      instructions: opts.instructions,
      messages: transcript,
      tools: opts.tools,
      stopWhen: [isStepCount(stepCap), noDoomLoop, noCycleLoop],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: opts.abortSignal,
      maxRetries: 0,
      prepareStep: ({ messages, stepNumber, steps }) => {
        // Frames captured in the prior step's tools, then steers, become real
        // transcript messages (persisted); the bar is a transient tail.
        const images = opts.drainImages();
        if (images.length > 0) {
          transcript.push(...images);
        }
        const steers = opts.drainSteers();
        if (steers.length > 0) {
          transcript.push(...steerMessages(steers));
        }
        if (images.length > 0 || steers.length > 0) {
          opts.onPersist(transcript);
        }
        // `messages` carries the SDK's own accumulated view; append our
        // extra context and the fresh bar to it.
        const base = messages.filter((message) => !isBar(message));
        for (const message of [...images, ...steerMessages(steers)]) {
          base.push(message);
        }
        return {
          messages: withHarnessBar(
            trim(base),
            renderBar(stepNumber, stepCap, steps, steers.length)
          ),
        };
      },
      onStepFinish: (step) => {
        transcript.push(...step.response.messages);
        opts.onPersist(transcript);
      },
    });
    return result.fullStream;
  };

  return (async function* rounds(): AsyncGenerator<TextStreamPart<ToolSet>> {
    for (let round = 0; round < MAX_STEER_ROUNDS; round += 1) {
      opts.abortSignal.throwIfAborted();
      yield* runRound();
      // A steer that landed after the model stopped calling tools is not seen
      // by any `prepareStep`; run one more round so it is answered.
      const steers = opts.drainSteers();
      if (steers.length === 0) {
        break;
      }
      transcript.push(...steerMessages(steers));
      opts.onPersist(transcript);
    }
  })();
};
