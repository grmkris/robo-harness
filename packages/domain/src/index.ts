// Robot value types shared by the coordinator, the workbench and the CLI.
// Defined as Effect Schema so the same declaration validates the wire boundary
// (the Python I/O service) and produces the TypeScript types.
import { Schema } from "effect";

export const joints = [
  "shoulder_pan",
  "shoulder_lift",
  "elbow_flex",
  "wrist_flex",
  "wrist_roll",
  "gripper",
] as const;
export const Joint = Schema.Literals(joints);
export type Joint = (typeof joints)[number];

export const Pose = Schema.Struct({
  shoulder_pan: Schema.Finite,
  shoulder_lift: Schema.Finite,
  elbow_flex: Schema.Finite,
  wrist_flex: Schema.Finite,
  wrist_roll: Schema.Finite,
  gripper: Schema.Finite,
});
export type Pose = typeof Pose.Type;

export const Operation = Schema.Struct({
  id: Schema.String,
  request_id: Schema.String,
  owner: Schema.String,
  status: Schema.Literals([
    "accepted",
    "running",
    "completed",
    "cancelled",
    "failed",
  ]),
  target: Pose,
  residual: Schema.NullOr(Pose),
  reason: Schema.optionalKey(Schema.String),
});
export type Operation = typeof Operation.Type;

export const Observation = Schema.Struct({
  boot_id: Schema.String,
  seq: Schema.Int,
  monotonic_s: Schema.Finite,
  wall_time_ms: Schema.Finite,
  server_time_ms: Schema.optionalKey(Schema.Finite),
  clock_domain: Schema.String,
  age_ms: Schema.Finite,
  units: Schema.Record(Schema.String, Schema.String),
  backend: Schema.Literals(["mock", "so101"]),
  calibration_id: Schema.String,
  measured: Pose,
  commanded: Pose,
  ee: Schema.Array(Schema.Finite),
  frames: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Array(Schema.Finite))
  ),
  cameras: Schema.Record(
    Schema.String,
    Schema.Struct({
      seq: Schema.Int,
      age_ms: Schema.NullOr(Schema.Finite),
      error: Schema.NullOr(Schema.String),
    })
  ),
  operator: Schema.NullOr(
    Schema.Struct({
      owner: Schema.String,
      mode: Schema.String,
      remaining_ms: Schema.Finite,
    })
  ),
  operation: Schema.NullOr(Operation),
  fault: Schema.NullOr(Schema.String),
  limits: Schema.Record(Joint, Schema.Tuple([Schema.Finite, Schema.Finite])),
  max_step: Schema.Finite,
  cartesian: Schema.Boolean,
  trajectory: Schema.Array(Schema.Array(Schema.Finite)),
});
export type Observation = typeof Observation.Type;

export const Frame = Schema.Struct({
  id: Schema.String,
  camera: Schema.String,
  seq: Schema.Int,
  monotonic_s: Schema.Finite,
  wall_time_ms: Schema.Finite,
  clock_domain: Schema.String,
  age_ms: Schema.Finite,
  width: Schema.Int,
  height: Schema.Int,
  media_type: Schema.String,
  base64: Schema.String,
  calibration: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type Frame = typeof Frame.Type;

export const Lease = Schema.Struct({
  lease_id: Schema.String,
  ttl_ms: Schema.Int,
  owner: Schema.String,
  mode: Schema.String,
});
export type Lease = typeof Lease.Type;

export const AppEvent = Schema.Struct({
  id: Schema.Int,
  time: Schema.Int,
  type: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
});
export type AppEvent = typeof AppEvent.Type;

export const ProviderInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  available: Schema.Boolean,
  model: Schema.String,
  vision: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
});
export type ProviderInfo = typeof ProviderInfo.Type;
