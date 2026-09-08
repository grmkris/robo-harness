import { expect, test } from "bun:test";

import type { ModelMessage } from "@tanstack/ai";

import {
  closePendingCalls,
  decodeHistory,
  encodeHistory,
} from "./chat-history";

const call: ModelMessage = {
  role: "assistant",
  content: "Moving",
  toolCalls: [
    {
      id: "old-move",
      type: "function",
      function: { name: "move_joints", arguments: '{"target":{"gripper":42}}' },
    },
  ],
};

test("legacy tool call/result pairs retain identity and output after migration", () => {
  const legacy = [
    { role: "user", content: "move a little" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Moving" },
        {
          type: "tool-call",
          toolCallId: "old-move",
          toolName: "move_joints",
          input: { target: { gripper: 42 } },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "old-move",
          toolName: "move_joints",
          output: { type: "json", value: { status: "completed" } },
        },
      ],
    },
  ];
  const migrated = decodeHistory(JSON.stringify(legacy));
  expect(migrated).toHaveLength(3);
  expect(migrated[1]).toEqual(call);
  expect(migrated[2]?.content).toContain("completed");
  expect(decodeHistory(encodeHistory(migrated))).toEqual(migrated);
});
test("unresolved historical actions are closed without replay or invented success", () => {
  const messages = closePendingCalls([
    call,
    { role: "user", content: "continue" },
  ]);
  expect(messages[1]?.role).toBe("tool");
  expect(messages[1]?.toolCallId).toBe("old-move");
  expect(messages[1]?.content).toContain("OUTCOME_UNKNOWN");
  expect(closePendingCalls(messages)).toEqual(messages);
  expect(decodeHistory(encodeHistory([call]))).toHaveLength(2);
});
test("camera bytes are never stored and unsupported transcript versions fail closed", () => {
  const encoded = encodeHistory([
    {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "data",
            mimeType: "image/jpeg",
            value: "fixture-image-bytes",
          },
        },
      ],
    },
  ]);
  expect(encoded).not.toContain("fixture-image-bytes");
  expect(encoded).toContain("[camera frame]");
  expect(() => decodeHistory('{"version":99,"messages":[]}')).toThrow();
  expect(() =>
    decodeHistory('{"version":1,"messages":[{"role":"root","content":"bad"}]}')
  ).toThrow();
});
