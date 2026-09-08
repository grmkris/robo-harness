import { Effect, Schema } from "effect";
const Seconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
export const RecordingId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9-]{36}$/u)
);
export const RecordingExport = Schema.Struct({
  id: RecordingId,
  kind: Schema.Literals(["mp4", "lerobot"]),
  start_s: Seconds.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  end_s: Schema.optionalKey(Seconds),
  task: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  outcome: Schema.Literals(["unreviewed", "success", "failure"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("unreviewed" as const))
  ),
  intervention: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  camera: Schema.Literals(["workspace", "wrist", "both"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("both" as const))
  ),
  speed: Schema.Literals([1, 2, 4, 8]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(1 as const))
  ),
  overlay: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true))
  ),
});
export type RecordingExport = typeof RecordingExport.Type;
export const RecordingArtifact = Schema.Struct({
  id: RecordingId,
  kind: Schema.Literals(["mp4", "lerobot"]),
  state: Schema.Literals(["running", "completed", "failed"]),
  task: Schema.String,
  start_s: Seconds,
  end_s: Schema.optionalKey(Seconds),
  outcome: Schema.String,
  intervention: Schema.Boolean,
  url: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type RecordingArtifact = typeof RecordingArtifact.Type;
export const RecordingDetail = Schema.Struct({
  id: RecordingId,
  label: Schema.String,
  state: Schema.String,
  duration_s: Seconds,
  frames: Schema.Int,
  sampling_fps: Schema.Finite,
  backend: Schema.String,
  bookmarks: Schema.Array(
    Schema.Struct({ time_s: Seconds, type: Schema.String, text: Schema.String })
  ),
  exports: Schema.Array(RecordingArtifact),
  quality: Schema.Struct({
    max_camera_skew_ms: Schema.Finite,
    training_intervals: Schema.Array(
      Schema.Struct({ start_s: Seconds, end_s: Seconds })
    ),
  }),
});
export type RecordingDetail = typeof RecordingDetail.Type;
