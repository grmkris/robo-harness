import { existsSync } from "node:fs";

import {
  type PerceptionCheck,
  type PerceptionDetail,
  PerceptionResult,
} from "@robo/domain";
import { Schema } from "effect";

import { config } from "./config";
import { ApiError } from "./robot";
import { db } from "./store";

const Row = Schema.Struct({
  rowid: Schema.Int,
  id: Schema.String,
  state: Schema.String,
  source: Schema.String,
  result: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  created: Schema.Finite,
});
const Source = Schema.Struct({
  id: Schema.String,
  camera: Schema.String,
  wall_time_ms: Schema.Finite,
  width: Schema.Int,
  height: Schema.Int,
  kind: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  recording_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const ResultMeta = Schema.Struct({
  kind: Schema.String,
  model: Schema.String,
  completed_ms: Schema.optionalKey(Schema.Finite),
});
const summary = (row: typeof Row.Type): PerceptionCheck => {
  const source = Schema.decodeUnknownSync(Source)(JSON.parse(row.source));
  const result = row.result
    ? Schema.decodeUnknownSync(ResultMeta)(JSON.parse(row.result))
    : null;
  return {
    id: row.id,
    state: row.state,
    created: row.created,
    completed_ms: result?.completed_ms ?? null,
    camera: source.camera,
    frame_id: source.id,
    captured_ms: source.wall_time_ms,
    width: source.width,
    height: source.height,
    kind: source.kind ?? result?.kind ?? "unknown",
    prompt: source.prompt ?? "Previous check",
    model: result?.model ?? source.model ?? "Unknown",
    recording_id: source.recording_id ?? null,
    error: row.error,
    source_url: existsSync(`${config.dataDir}/perception/${row.id}/source.jpg`)
      ? `/api/perception/${row.id}/source`
      : null,
    preview_url: row.state === "completed" ? `/api/perception/${row.id}` : null,
  };
};
export const perceptionHistory = (
  before: number,
  recordingId: string | null = null
) => {
  const rows = Schema.decodeUnknownSync(Schema.Array(Row))(
    db
      .query(
        "SELECT rowid,* FROM perception WHERE rowid<? AND (? IS NULL OR json_extract(source,'$.recording_id')=?) ORDER BY rowid DESC LIMIT 25"
      )
      .all(before, recordingId, recordingId)
  );
  return {
    items: rows.map(summary),
    next: rows.length === 25 ? rows.at(-1)!.rowid : null,
  };
};
export const perceptionDetail = (id: string): PerceptionDetail => {
  const raw = db.query("SELECT rowid,* FROM perception WHERE id=?").get(id);
  if (!raw) throw new ApiError("Perception check not found", 404);
  const row = Schema.decodeUnknownSync(Row)(raw);
  return {
    check: summary(row),
    result: row.result
      ? Schema.decodeUnknownSync(PerceptionResult)(JSON.parse(row.result))
      : null,
  };
};
