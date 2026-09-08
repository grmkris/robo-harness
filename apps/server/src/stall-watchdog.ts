import { EventType } from "@tanstack/ai";
import { Effect, Stream } from "effect";

import type { ChatAdapter } from "./chat-stream";
import { scopedChatStream } from "./chat-stream";

export interface StallLimits {
  readonly firstChunkMs: number;
  readonly chunkMs: number;
}

/** Bound provider pulls including connection setup. Tools have independent
 * deadlines; a legitimate measured-motion wait is never a provider stall. */
export const stallWatchdog = (
  adapter: ChatAdapter,
  limits: StallLimits
): ChatAdapter => ({
  kind: adapter.kind,
  name: adapter.name,
  model: adapter.model,
  "~types": adapter["~types"],
  structuredOutput: adapter.structuredOutput.bind(adapter),
  chatStream: (options) => {
    const signal =
      options.request instanceof Request
        ? options.request.signal
        : options.request?.signal;
    const firstDeadline = performance.now() + limits.firstChunkMs;
    let started = false;
    const stream = scopedChatStream(
      (controller) =>
        adapter.chatStream({
          ...options,
          request:
            options.request instanceof Request
              ? new Request(options.request, { signal: controller.signal })
              : { ...options.request, signal: controller.signal },
        }),
      signal ?? new AbortController().signal,
      () =>
        started
          ? limits.chunkMs
          : Math.max(1, firstDeadline - performance.now())
    ).pipe(
      Stream.tap((chunk) =>
        Effect.sync(() => {
          if (chunk.type !== EventType.RUN_STARTED) started = true;
        })
      )
    );
    return Stream.toAsyncIterable(stream);
  },
});
