import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { LanguageModelMiddleware } from "ai";

/**
 * Bound a hung PROVIDER stream, and only that (ported from invok's harness).
 * The SDK's own `timeout.chunkMs` runs over the step's composed stream — tool
 * results included — so a tool that legitimately takes a while (a bounded move
 * awaiting measured completion) counted as "the model stopped streaming" and
 * the turn died mid-wait. This watchdog sits on the raw `doStream` result,
 * where the only thing between two chunks is the network and the model, and
 * errors the stream when that goes quiet. Tools keep their own deadlines.
 */

export interface StallLimits {
  /** Nothing at all after the request was sent. */
  readonly firstChunkMs: number;
  /** Silence in the middle of a stream that had started. */
  readonly chunkMs: number;
}

type StallPhase = "first" | "mid";

class ProviderStallError extends Error {
  override readonly name = "ProviderStallError";
  readonly phase: StallPhase;
  constructor(phase: StallPhase, waitedMs: number) {
    const waited =
      waitedMs >= 1000
        ? `${String(Math.round(waitedMs / 1000))} s`
        : `${String(waitedMs)} ms`;
    super(
      phase === "first"
        ? `the model sent nothing for ${waited}`
        : `the model stopped mid-stream: nothing for ${waited}`
    );
    this.phase = phase;
  }
}

/** `stream-start` carries the request's warnings and is emitted before any
 *  byte of the response body is read: it says nothing about liveness. */
const isLivenessChunk = (part: LanguageModelV4StreamPart): boolean =>
  part.type !== "stream-start";

const stallTransform = (
  limits: StallLimits
): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const arm = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    phase: StallPhase,
    ms: number
  ): void => {
    clear();
    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        controller.error(new ProviderStallError(phase, ms));
      } catch {
        // The consumer walked away (a stopped turn cancels the stream) and
        // `flush` never ran, so the controller is already closed. There is
        // nobody left to tell; erroring it again would throw out of a timer
        // callback and take the process with it.
      }
    }, ms);
    // A consumer that walks away mid-stream never runs `flush`; an unref'd
    // timer cannot hold the process open waiting to fire into nothing.
    timer.unref?.();
  };
  return new TransformStream({
    start: (controller) => {
      arm(controller, "first", limits.firstChunkMs);
    },
    transform: (part, controller) => {
      controller.enqueue(part);
      if (isLivenessChunk(part)) {
        arm(controller, "mid", limits.chunkMs);
      }
    },
    flush: () => {
      settled = true;
      clear();
    },
  });
};

export const stallWatchdog = (
  limits: StallLimits
): LanguageModelMiddleware => ({
  specificationVersion: "v4",
  wrapStream: async ({ doStream }) => {
    const result = await doStream();
    return {
      ...result,
      stream: result.stream.pipeThrough(stallTransform(limits)),
    };
  },
});
