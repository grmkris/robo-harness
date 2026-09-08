import type { ModelMessage } from "@tanstack/ai";
import { Schema } from "effect";

const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  content: Schema.String,
});
const ToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
});
const Message = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "tool"]),
  content: Schema.Union([Schema.String, Schema.Null, Schema.Array(TextPart)]),
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  toolCallId: Schema.optionalKey(Schema.String),
  toolCalls: Schema.optionalKey(Schema.Array(ToolCall)),
  thinking: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        content: Schema.String,
        signature: Schema.optionalKey(Schema.String),
      })
    )
  ),
});
const Transcript = Schema.Struct({
  version: Schema.Literal(1),
  messages: Schema.Array(Message),
});
const LegacyPart = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  toolCallId: Schema.optionalKey(Schema.String),
  toolName: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Unknown),
  output: Schema.optionalKey(Schema.Unknown),
});
const Legacy = Schema.Array(
  Schema.Struct({
    role: Schema.Literals(["user", "assistant", "tool"]),
    content: Schema.Union([Schema.String, Schema.Array(LegacyPart)]),
  })
);

const mutable = (messages: typeof Transcript.Type.messages): ModelMessage[] =>
  messages.map(({ content, toolCalls, thinking, ...message }) => ({
    ...message,
    content:
      typeof content === "string" || content === null ? content : [...content],
    ...(toolCalls ? { toolCalls: [...toolCalls] } : {}),
    ...(thinking ? { thinking: [...thinking] } : {}),
  }));

/** Old rows are decoded and translated on read; the next write versions them.
 * No bulk rewrite, and no replay of stored tool calls. */
const readHistory = (json: string): ModelMessage[] => {
  const value: unknown = JSON.parse(json);
  const current = Schema.decodeUnknownOption(Transcript)(value);
  if (current._tag === "Some") return mutable(current.value.messages);
  const legacy = Schema.decodeUnknownSync(Legacy)(value);
  return legacy.flatMap((message): ModelMessage[] => {
    if (typeof message.content === "string")
      return [{ ...message, content: message.content }];
    if (message.role === "tool")
      return message.content.map((part) => {
        if (part.type !== "tool-result" || !part.toolCallId)
          throw new Error("Invalid historical tool result");
        const output = Schema.decodeUnknownSync(
          Schema.Struct({ type: Schema.String, value: Schema.Unknown })
        )(part.output);
        return {
          role: "tool",
          toolCallId: part.toolCallId,
          content:
            typeof output.value === "string"
              ? output.value
              : JSON.stringify(output.value),
        };
      });
    const toolCalls = message.content
      .filter((part) => part.type === "tool-call")
      .map((part) => {
        if (!part.toolCallId || !part.toolName)
          throw new Error("Invalid historical tool call");
        return {
          id: part.toolCallId,
          type: "function" as const,
          function: {
            name: part.toolName,
            arguments: JSON.stringify(part.input ?? {}),
          },
        };
      });
    return [
      {
        role: message.role,
        content: message.content
          .map((part) =>
            part.type === "text"
              ? (part.text ?? "")
              : part.type === "image"
                ? "[camera frame]"
                : ""
          )
          .join(""),
        ...(toolCalls.length ? { toolCalls } : {}),
      },
    ];
  });
};

export const encodeHistory = (messages: readonly ModelMessage[]): string => {
  const stripped = messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part) =>
          part.type === "text"
            ? part
            : { type: "text", content: "[camera frame]" }
        )
      : message.content,
  }));
  return JSON.stringify(
    Schema.decodeUnknownSync(Transcript)({ version: 1, messages: stripped })
  );
};

/** Never resume pending execution from disk. A missing result is uncertain,
 * including a coordinator crash after physical submission but before commit. */
export const closePendingCalls = (
  messages: readonly ModelMessage[]
): ModelMessage[] => {
  const result: ModelMessage[] = [];
  let pending: string[] = [];
  const close = () => {
    for (const toolCallId of pending)
      result.push({
        role: "tool",
        toolCallId,
        content: JSON.stringify({
          error:
            "OUTCOME_UNKNOWN: The previous run ended without a recorded result. Do not retry this action. Observe measured state before deciding what to do next.",
        }),
      });
    pending = [];
  };
  for (const message of messages) {
    if (message.role !== "tool") close();
    result.push(message);
    if (message.role === "assistant")
      pending = message.toolCalls?.map((call) => call.id) ?? [];
    if (message.role === "tool")
      pending = pending.filter((id) => id !== message.toolCallId);
  }
  close();
  return result;
};

export const decodeHistory = (json: string): ModelMessage[] =>
  closePendingCalls(readHistory(json));
