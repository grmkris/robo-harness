import type { TextOptions } from "@tanstack/ai";
import { OpenAICompatibleChatAdapter } from "@tanstack/ai-openai/compatible";
import { Option, Schema } from "effect";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

const ReasoningChunk = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      delta: Schema.Struct({
        reasoning_content: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    })
  ),
});

/** TanStack 0.58's compatible adapter widens optional fields to required/null
 * automatically. The robot contract requires omitted-or-number, never null.
 * Use the documented request-mapping extension point to keep that contract
 * on the wire; the native adapter still owns messages, images and streaming. */
export class RobotChatAdapter extends OpenAICompatibleChatAdapter<
  string,
  Record<string, unknown>,
  readonly ["text", "image"],
  readonly []
> {
  /** Qwen streams reasoning_content before text/tool deltas. Forward its
   * lifecycle so the provider watchdog sees activity while it thinks. */
  protected override extractReasoning(
    chunk: ChatCompletionChunk
  ): { text: string } | undefined {
    if (this.name !== "alibaba") return super.extractReasoning(chunk);
    const decoded = Schema.decodeUnknownOption(ReasoningChunk)(chunk);
    const text = Option.isSome(decoded)
      ? decoded.value.choices[0]?.delta.reasoning_content
      : undefined;
    return text ? { text } : undefined;
  }

  protected override mapOptionsToRequest(
    options: TextOptions<Record<string, unknown>>
  ) {
    const request = super.mapOptionsToRequest(options);
    if (options.tools) {
      request.tools = options.tools.map((tool) => ({
        type: "function",
        function: {
          name: Schema.decodeUnknownSync(Schema.String)(tool.name),
          description: tool.description,
          parameters: Schema.decodeUnknownSync(
            Schema.Record(Schema.String, Schema.Unknown)
          )(tool.inputSchema),
          strict: false,
        },
      }));
    }
    return request;
  }
}
