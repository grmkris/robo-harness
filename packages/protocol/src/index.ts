import { joints, RecordingId, RecordingExport, type Joint } from "@robo/domain";
import { Effect, Schema } from "effect";

import { std } from "./std";

export { callTool } from "./client";
export { std } from "./std";

const RequestId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128)
);
export const Duration = Schema.Finite.check(
  Schema.isBetween({ minimum: 0.1, maximum: 10 })
).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1)));
const Angle = Schema.optionalKey(Schema.Finite);
// Keys come from the domain joint list so a move target cannot drift from it.
export const JointTarget = Schema.Struct(
  Object.fromEntries(joints.map((joint) => [joint, Angle])) as Record<
    Joint,
    typeof Angle
  >
).check(Schema.isMinProperties(1));
// A move is joints XOR a Cartesian target. A single object (both keys optional)
// keeps the JSON Schema a plain object for MCP; the refine enforces exactly one,
// and strict decoding (onExcessProperty: "error") rejects an injected field.
const MoveBase = Schema.Struct({
  request_id: RequestId,
  target: Schema.optionalKey(JointTarget),
  xyz: Schema.optionalKey(
    Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite])
  ),
  duration_s: Duration,
});
export const moveSchema = MoveBase.pipe(
  Schema.refine(
    (v): v is typeof MoveBase.Type =>
      (v.target === undefined) !== (v.xyz === undefined),
    { message: "Specify joints or a Cartesian target, not both" }
  )
);
export type MoveInput = typeof moveSchema.Type;

const Camera = Schema.Literals(["workspace", "wrist"]);
export const toolSchemas = {
  observe: Schema.Struct({}),
  capture: Schema.Struct({ camera: Camera }),
  acquire: Schema.Struct({
    mode: Schema.Literals(["agent", "human", "leader"]).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("agent" as const))
    ),
    takeover: Schema.Boolean.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(false))
    ),
  }),
  release: Schema.Struct({}),
  renew: Schema.Struct({}),
  move: moveSchema,
  operation: Schema.Struct({ id: Schema.String }),
  stop: Schema.Struct({}),
  perceive: Schema.Struct({
    camera: Camera,
    kind: Schema.Literals(["segment", "depth"]),
    prompt: Schema.String.check(Schema.isMaxLength(200)).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("object"))
    ),
    frame_id: Schema.optionalKey(Schema.String),
  }),
  recording_start: Schema.Struct({
    label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  }),
  recording_stop: Schema.Struct({}),
  recording_list: Schema.Struct({}),
  recording_inspect: Schema.Struct({ id: RecordingId }),
  recording_frame: Schema.Struct({
    id: RecordingId,
    camera: Camera,
    time_s: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  recording_export: RecordingExport,
  shell: Schema.Struct({
    command: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(16_000)
    ),
    host: Schema.Literals(["netcup", "pi"]).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("netcup" as const))
    ),
    timeout_s: Schema.Finite.check(
      Schema.isBetween({ minimum: 1, maximum: 120 })
    ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(30))),
  }),
} as const;
export type ToolName = keyof typeof toolSchemas;

// The model requires each tool's input to be an object schema. A no-argument
// tool serialises to an `anyOf`, which some providers (xAI) reject, so it is
// normalised to an empty object.
export const toolInputSchema = (name: ToolName) => {
  const json = std(toolSchemas[name])["~standard"].jsonSchema.input({
    target: "draft-2020-12",
  }) as Record<string, unknown>;
  if (json["type"] === "object") {
    return name === "move"
      ? { ...json, oneOf: [{ required: ["target"] }, { required: ["xyz"] }] }
      : json;
  }
  if (
    [
      "observe",
      "release",
      "renew",
      "stop",
      "recording_stop",
      "recording_list",
    ].includes(name)
  ) {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  throw new Error(`Tool ${name} must expose an object schema`);
};
