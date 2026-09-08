import { Schema } from "effect";
const Pixels = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(4096)
);
export const PerceptionResult = Schema.Struct({
  kind: Schema.Literals(["segment", "depth"]),
  model: Schema.String,
  model_version: Schema.String,
  frame_id: Schema.String,
  width: Pixels,
  height: Pixels,
  preview_png: Schema.String,
  provider_request_id: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  preview_width: Schema.optionalKey(Pixels),
  preview_height: Schema.optionalKey(Pixels),
  preview_to_image: Schema.optionalKey(
    Schema.Array(Schema.Array(Schema.Finite))
  ),
  masks: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        png: Schema.String,
        label: Schema.String,
        score: Schema.optionalKey(Schema.Finite),
        area_pixels: Schema.optionalKey(Schema.Int),
        bounds_pixels: Schema.optionalKey(
          Schema.NullOr(Schema.Array(Schema.Finite))
        ),
      })
    )
  ),
  depth: Schema.optionalKey(Schema.Array(Schema.Array(Schema.Finite))),
  depth_width: Schema.optionalKey(Schema.Int),
  depth_height: Schema.optionalKey(Schema.Int),
  depth_to_image: Schema.optionalKey(Schema.Array(Schema.Array(Schema.Finite))),
  units: Schema.optionalKey(Schema.Literals(["relative", "meters", "pixels"])),
});

export const PerceptionCheck = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  created: Schema.Finite,
  completed_ms: Schema.NullOr(Schema.Finite),
  camera: Schema.String,
  frame_id: Schema.String,
  captured_ms: Schema.Finite,
  width: Schema.Int,
  height: Schema.Int,
  kind: Schema.String,
  prompt: Schema.String,
  model: Schema.String,
  source_url: Schema.NullOr(Schema.String),
  preview_url: Schema.NullOr(Schema.String),
  recording_id: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type PerceptionCheck = typeof PerceptionCheck.Type;
export const PerceptionPage = Schema.Struct({
  items: Schema.Array(PerceptionCheck),
  next: Schema.NullOr(Schema.Int),
});
export const PerceptionDetail = Schema.Struct({
  check: PerceptionCheck,
  result: Schema.NullOr(PerceptionResult),
});
export type PerceptionDetail = typeof PerceptionDetail.Type;
