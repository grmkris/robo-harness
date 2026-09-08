import { moveSchema } from "@robo/protocol";
import { Schema } from "effect";

import {
  ActionResult,
  type ActionLedger,
  type ActionRecord,
} from "./motion-actions";
import { db } from "./store";

const RecordSchema = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  requestId: Schema.String,
  input: moveSchema,
  bootId: Schema.NullOr(Schema.String),
  result: Schema.NullOr(ActionResult),
});

// Additive schema migration: existing transcripts and manual operations stay
// untouched. Pending records after a restart remain unknown and cannot replay.
db.exec(
  "CREATE TABLE IF NOT EXISTS chat_actions(id TEXT PRIMARY KEY, record TEXT NOT NULL, updated INTEGER NOT NULL)"
);

export const actionLedger: ActionLedger = {
  get: (id) => {
    const row = db
      .query<{ record: string }, [string]>(
        "SELECT record FROM chat_actions WHERE id=?"
      )
      .get(id);
    if (!row) return null;
    const parsed = Schema.decodeUnknownSync(RecordSchema)(
      JSON.parse(row.record)
    );
    const { request_id: _requestId, ...input } = parsed.input;
    return { ...parsed, input };
  },
  save: (record: ActionRecord) => {
    const value = {
      ...record,
      input: { ...record.input, request_id: record.requestId },
    };
    db.query(
      "INSERT INTO chat_actions(id,record,updated) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record,updated=excluded.updated"
    ).run(record.id, JSON.stringify(value), Date.now());
  },
};
