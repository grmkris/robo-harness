// Robot value types shared by the coordinator, the workbench and the CLI.
// Defined as Effect Schema so the same declaration validates the wire boundary
// (the Python I/O service) and produces the TypeScript types.
import { Effect, Schema } from "effect";

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
  measured: Schema.optionalKey(Pose),
  residual: Schema.NullOr(Pose),
  reason: Schema.optionalKey(Schema.String),
});
export type Operation = typeof Operation.Type;

export const Observation = Schema.Struct({
  boot_id: Schema.String,
  control_epoch: Schema.optionalKey(Schema.Int),
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
  // /control/stop returns an observation without the camera map; default it to
  // empty so the same schema decodes both, while /observe still carries cameras.
  cameras: Schema.Record(
    Schema.String,
    Schema.Struct({
      seq: Schema.Int,
      age_ms: Schema.NullOr(Schema.Finite),
      error: Schema.NullOr(Schema.String),
    })
  ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  operator: Schema.NullOr(
    Schema.Struct({
      owner: Schema.String,
      mode: Schema.String,
      remaining_ms: Schema.Finite,
    })
  ),
  operation: Schema.NullOr(Operation),
  // Present only under a stream lease: how old the newest setpoint is, whether
  // it is still being followed, and why a candidate was last dropped.
  stream: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        age_ms: Schema.Finite,
        following: Schema.Boolean,
        rejected: Schema.NullOr(Schema.String),
      })
    )
  ),
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
  calibration: Schema.optionalKey(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))
  ),
});
export type Frame = typeof Frame.Type;

/** Saved camera evidence in a chat tool result; bytes use an authenticated URL. */
export const ChatCapture = Schema.Struct({
  image_id: Schema.String.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
  ),
  id: Frame.fields.id,
  camera: Frame.fields.camera,
  seq: Frame.fields.seq,
  wall_time_ms: Frame.fields.wall_time_ms,
  age_ms: Frame.fields.age_ms,
  width: Frame.fields.width,
  height: Frame.fields.height,
  archived: Schema.Boolean,
});
export type ChatCapture = typeof ChatCapture.Type;

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

export const ModelCapabilities = Schema.Struct({
  model: Schema.String,
  image_input: Schema.Boolean,
  tool_calling: Schema.Boolean,
  strict_tools: Schema.Boolean,
  parallel_control: Schema.Boolean,
  /**
   * Where the capability claim comes from. `documented`: the vendor documents
   * it for this model at its own endpoint. `gateway`: the same model through a
   * local proxy, inherited by assumption -- nothing checked what the proxy
   * actually forwards to. `configured`: the operator asserted it.
   * `unverified`: nobody has said.
   */
  source: Schema.Literals([
    "documented",
    "gateway",
    "configured",
    "unverified",
  ]),
});
export type ModelCapabilities = typeof ModelCapabilities.Type;

export const ProviderInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  available: Schema.Boolean,
  // The default model, and the full set a caller may choose from. `model` is
  // `models[0]`; both are kept so an older client that only reads `model` works.
  model: Schema.String,
  models: Schema.Array(Schema.String),
  capabilities: Schema.Array(ModelCapabilities),
  vision: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
});
export type ProviderInfo = typeof ProviderInfo.Type;

export {
  TerminalSize,
  TerminalSession,
  TerminalClientMessage,
  TerminalServerMessage,
} from "./terminal";
export {
  RecordingId,
  RecordingExport,
  RecordingArtifact,
  RecordingDetail,
} from "./recording";

export {
  PerceptionResult,
  PerceptionCheck,
  PerceptionPage,
  PerceptionDetail,
} from "./perception";
