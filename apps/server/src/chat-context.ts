import type { ModelMessage } from "@tanstack/ai";

// Three pairs of workspace/wrist views let the model compare successive probes.
const MAX_CONTEXT_IMAGES = 6;
const HISTORY_TEXT_CHAR_CAP = 100_000;

/** Image bytes have their own bound: base64 length is not a text-token budget. */
const textSize = (messages: readonly ModelMessage[]): number =>
  JSON.stringify(
    messages.map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((part) =>
            part.type === "image" ? { type: "text", content: "[image]" } : part
          )
        : message.content,
    }))
  ).length;

export const trimContext = (
  messages: readonly ModelMessage[]
): ModelMessage[] => {
  let imageCount = 0;
  let kept = messages
    .toReversed()
    .map((message): ModelMessage => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content
            .toReversed()
            .map((part) => {
              if (part.type !== "image") return part;
              imageCount += 1;
              return imageCount <= MAX_CONTEXT_IMAGES
                ? part
                : {
                    type: "text" as const,
                    content:
                      "[Older camera image omitted from model context; its capture metadata remains.]",
                  };
            })
            .toReversed()
        : message.content,
    }))
    .toReversed();
  while (textSize(kept) > HISTORY_TEXT_CHAR_CAP) {
    // Camera observations are user-role multipart messages, not new operator
    // turns. Never evict the active task or split its tool-call/result groups.
    const nextTurn = kept.findIndex(
      (message, index) =>
        index > 0 &&
        message.role === "user" &&
        typeof message.content === "string"
    );
    if (nextTurn < 1) break;
    kept = kept.slice(nextTurn);
  }
  return kept;
};
