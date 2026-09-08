import type {
  DefaultMessageMetadataByModality,
  Modality,
  TextAdapter,
} from "@tanstack/ai";
import { Cause, Effect, Schema, Stream } from "effect";

export type ChatAdapter = TextAdapter<
  string,
  Record<string, unknown>,
  readonly Modality[],
  DefaultMessageMetadataByModality
>;

export type ChatEvent =
  | { type: "start-step" | "finish-step" }
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      output: unknown;
    }
  | {
      type: "tool-error";
      toolCallId: string;
      toolName: string;
      error: unknown;
    };

export class ChatRunError extends Schema.TaggedError<ChatRunError>()(
  "ChatRunError",
  {
    cause: Schema.Defect(),
  }
) {}

/** One Effect scope owns the controller AND iterator. Abort before awaiting
 * iterator.return(), including when a stream consumer leaves early. */
export const scopedChatStream = <A>(
  make: (controller: AbortController) => AsyncIterable<A>,
  signal: AbortSignal,
  timeoutMs?: () => number
): Stream.Stream<A, ChatRunError> =>
  Stream.scoped(
    Stream.fromPull(
      Effect.gen(function* acquireChatStream() {
        const resource = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const controller = new AbortController();
            const abort = () => controller.abort(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
            const iterator = make(controller)[Symbol.asyncIterator]();
            return { controller, abort, iterator };
          }),
          ({ controller, abort, iterator }) =>
            Effect.promise(async () => {
              signal.removeEventListener("abort", abort);
              controller.abort();
              await iterator.return?.();
            })
        );
        return Effect.suspend(() => {
          const next = Effect.tryPromise({
            try: () => resource.iterator.next(),
            catch: (cause) => new ChatRunError({ cause }),
          });
          const bounded = timeoutMs
            ? next.pipe(
                Effect.timeoutOrElse({
                  duration: timeoutMs(),
                  orElse: () =>
                    Effect.sync(() => resource.controller.abort()).pipe(
                      Effect.andThen(
                        Effect.fail(
                          new ChatRunError({
                            cause: new Error("Provider stream stalled"),
                          })
                        )
                      )
                    ),
                })
              )
            : next;
          return bounded.pipe(
            Effect.flatMap((value) =>
              value.done ? Cause.done() : Effect.succeed([value.value])
            )
          );
        });
      })
    )
  );
