import { joints, type Joint } from "@robo/domain";
import { Effect, Schema } from "effect";

import { std } from "./std";

export { callTool } from "./client";
export { std } from "./std";

const RequestId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128)
);
const Duration = Schema.Finite.check(
  Schema.isBetween({ minimum: 0.1, maximum: 10 })
).pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(1)));
const Angle = Schema.optionalKey(Schema.Finite);
// Keys come from the domain joint list so a move target cannot drift from it.
const PartialPose = Schema.Struct(
  Object.fromEntries(joints.map((joint) => [joint, Angle])) as Record<
    Joint,
    typeof Angle
  >
);
// A move is joints XOR a Cartesian target. A single object (both keys optional)
// keeps the JSON Schema a plain object for MCP; the refine enforces exactly one,
// and strict decoding (onExcessProperty: "error") rejects an injected field.
const MoveBase = Schema.Struct({
  request_id: RequestId,
  target: Schema.optionalKey(PartialPose),
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
      Schema.optional,
      Schema.withDecodingDefault(Effect.succeed("agent" as const))
    ),
    takeover: Schema.Boolean.pipe(
      Schema.optional,
      Schema.withDecodingDefault(Effect.succeed(false))
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
      Schema.optional,
      Schema.withDecodingDefault(Effect.succeed("object"))
    ),
    frame_id: Schema.optionalKey(Schema.String),
  }),
  recording_start: Schema.Struct({
    label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  }),
  recording_stop: Schema.Struct({}),
  shell: Schema.Struct({
    command: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(16_000)
    ),
    host: Schema.Literals(["netcup", "pi"]).pipe(
      Schema.optional,
      Schema.withDecodingDefault(Effect.succeed("netcup" as const))
    ),
    timeout_s: Schema.Finite.check(
      Schema.isBetween({ minimum: 1, maximum: 120 })
    ).pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(30))),
  }),
} as const;
export type ToolName = keyof typeof toolSchemas;

// The model requires each tool's input to be an object schema. A no-argument
// tool serialises to an `anyOf`, which some providers (xAI) reject, so it is
// normalised to an empty object.
export function toolInputSchema(name: ToolName): Record<string, unknown> {
  const json = std(toolSchemas[name])["~standard"].jsonSchema.input({
    target: "draft-2020-12",
  }) as Record<string, unknown>;
  return json["type"] === "object"
    ? json
    : { type: "object", properties: {}, additionalProperties: false };
}
