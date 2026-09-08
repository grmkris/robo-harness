import type { TextOptions } from "@tanstack/ai";
import { OpenAICompatibleChatAdapter } from "@tanstack/ai-openai/compatible";
import { Schema } from "effect";

/** TanStack 0.53's compatible adapter widens optional fields to required/null
 * automatically. The robot contract requires omitted-or-number, never null.
 * Use the documented request-mapping extension point to keep that contract
 * on the wire; the native adapter still owns messages, images and streaming. */
export class RobotChatAdapter extends OpenAICompatibleChatAdapter<
  string,
  Record<string, unknown>,
  readonly ["text", "image"],
  readonly []
> {
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
