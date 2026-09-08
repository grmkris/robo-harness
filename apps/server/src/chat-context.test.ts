import { expect, test } from "bun:test";

import type { ModelMessage } from "@tanstack/ai";

import { trimContext } from "./chat-context";

const frame = (id: number): ModelMessage => ({
  role: "user",
  content: [
    { type: "text", content: `Camera tool observation: frame-${id}` },
    {
      type: "image",
      source: {
        type: "data",
        value: String(id).repeat(80_000),
        mimeType: "image/jpeg",
      },
    },
  ],
});

test("image budget keeps recent comparison frames without erasing the task or mutating history", () => {
  const history: ModelMessage[] = [
    {
      role: "user",
      content: "Learn how the arm moves relative to the white piece.",
    },
    ...Array.from({ length: 8 }, (_, index) => frame(index)),
  ];
  const kept = trimContext(history);
  expect(kept[0]).toEqual(history[0]);
  const parts = kept.flatMap((message) =>
    Array.isArray(message.content) ? message.content : []
  );
  const images = parts.filter((part) => part.type === "image");
  expect(images).toHaveLength(6);
  expect(
    images.map((part) =>
      part.source.type === "data" ? part.source.value[0] : null
    )
  ).toEqual(["2", "3", "4", "5", "6", "7"]);
  expect(JSON.stringify(kept)).toContain("frame-0");
  expect(JSON.stringify(kept)).toContain("Older camera image omitted");
  expect(JSON.stringify(history)).not.toContain("omitted");
});

test("text trimming removes an old operator turn with its complete tool exchange", () => {
  const history: ModelMessage[] = [
    { role: "user", content: "Old task" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "old-call",
          type: "function",
          function: { name: "observe", arguments: "{}" },
        },
      ],
    },
    { role: "tool", toolCallId: "old-call", content: "x".repeat(110_000) },
    frame(0),
    { role: "user", content: "Current task" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "current-call",
          type: "function",
          function: { name: "observe", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "current-call",
      content: "Current measured pose",
    },
    frame(1),
  ];
  const kept = trimContext(history);
  expect(kept).toEqual(history.slice(4));
  expect(JSON.stringify(kept)).not.toContain("old-call");
  expect(JSON.stringify(kept)).toContain("current-call");
});

test("camera observations cannot masquerade as operator turns during text trimming", () => {
  const history: ModelMessage[] = [
    { role: "user", content: "Keep this active instruction" },
    { role: "assistant", content: "x".repeat(110_000) },
    frame(0),
    { role: "assistant", content: "I need both views to compare the probe." },
    frame(1),
  ];
  expect(trimContext(history)).toEqual(history);
});
