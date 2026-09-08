import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";

import { Schema } from "effect";

import { startHarness } from "./harness";

const legacy = [
  { role: "user", content: "Synthetic prior fixture action" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "historical",
        toolName: "move_joints",
        input: { target: { gripper: 42 } },
      },
    ],
  },
];

test("legacy rows migrate and continue through the real coordinator without replaying a pending action", async () => {
  const h = await startHarness({
    modelSteps: [
      { text: "Synthetic historical outcome was uncertain." },
      { text: "Synthetic continuation retained." },
    ],
  });
  const db = new Database(join(h.dataDir, "harness.sqlite"));
  const id = crypto.randomUUID();
  try {
    db.query(
      "INSERT INTO conversations(id,provider,model,created,messages) VALUES(?,?,?,?,?)"
    ).run(id, "alibaba", "fixture", Date.now(), JSON.stringify(legacy));
    const first = await h.request("/api/chat", {
      provider: "alibaba",
      model: "fixture",
      text: "Recall only",
      session_id: id,
    });
    expect(first.status).toBe(200);
    await h.until(async () => !(await h.status()).running.includes(id));
    expect(h.requests).toHaveLength(1);
    expect(JSON.stringify(h.requests[0]?.["messages"])).toContain(
      "OUTCOME_UNKNOWN"
    );
    expect((await h.status()).observation.operation).toBeNull();
    const row = Schema.decodeUnknownSync(
      Schema.Struct({ messages: Schema.String })
    )(db.query("SELECT messages FROM conversations WHERE id=?").get(id));
    expect(JSON.parse(row.messages)).toMatchObject({ version: 1 });
    const second = await h.request("/api/chat", {
      provider: "alibaba",
      model: "fixture",
      text: "Continue the fixture",
      session_id: id,
    });
    expect(second.status).toBe(200);
    await h.until(async () => !(await h.status()).running.includes(id));
    expect(h.requests).toHaveLength(2);
    expect(JSON.stringify(h.requests[1]?.["messages"])).toContain(
      "Synthetic historical outcome was uncertain."
    );
    expect((await h.status()).observation.operation).toBeNull();
  } finally {
    db.close();
    await h.close();
  }
}, 15_000);

test("invalid stored versions fail closed and release the chat reservation", async () => {
  const h = await startHarness();
  const db = new Database(join(h.dataDir, "harness.sqlite"));
  const id = crypto.randomUUID();
  try {
    db.query(
      "INSERT INTO conversations(id,provider,model,created,messages) VALUES(?,?,?,?,?)"
    ).run(id, "alibaba", "fixture", Date.now(), '{"version":99,"messages":[]}');
    const response = await h.request("/api/chat", {
      provider: "alibaba",
      model: "fixture",
      text: "fixture",
      session_id: id,
    });
    expect(response.status).toBe(502);
    expect((await h.status()).running).not.toContain(id);
    expect(h.requests).toHaveLength(0);
  } finally {
    db.close();
    await h.close();
  }
}, 15_000);
