import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Effect, Schema } from "effect";

/**
 * Coordinator-side manipulation settings: what the chat manipulation tools
 * need that the motor owner does not. Not the robo-io profile -- nothing here
 * reaches the motors, and the motor owner keeps its own limits and table
 * clearance whatever this file says.
 */
const Metres = Schema.Finite;
const Vec3 = Schema.Tuple([Metres, Metres, Metres]);
const Point = Schema.Tuple([Metres, Metres]);
const Degrees = Schema.Finite;
const Row = Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite]);

export const HomePose = Schema.Struct({
  shoulder_pan: Schema.optionalKey(Degrees),
  shoulder_lift: Schema.optionalKey(Degrees),
  elbow_flex: Schema.optionalKey(Degrees),
  wrist_flex: Schema.optionalKey(Degrees),
  wrist_roll: Schema.optionalKey(Degrees),
  gripper: Schema.optionalKey(Schema.Finite),
});

export const ManipulationConfig = Schema.Struct({
  /**
   * Tool centre point in gripper_frame_link coordinates, metres. The URDF
   * gripper frame is not where the fingertips are (on 2026-09-22 the fixed
   * finger was on the mat while the frame read 2.5 cm up), so contact and
   * grasp geometry is measured at this offset instead.
   */
  tcp_offset_m: Vec3.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([0, 0, 0] as const))
  ),
  /** Joint degrees (gripper percent) of a known safe pose; null when not set. */
  home_pose: Schema.NullOr(HomePose).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  safe_zone: Schema.Struct({
    /** Allowed TCP (x, y) region in the base frame, metres; null = radius only. */
    polygon: Schema.NullOr(
      Schema.Array(Point).check(Schema.isMinLength(3))
    ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
    /**
     * Furthest TCP distance from the base axis. The arm holds a pose reliably
     * out to about 0.17 m; past ~0.20 m shoulder_lift cannot hold against
     * gravity even at P=128 (2026-09-18).
     */
    max_radius_m: Metres.check(Schema.isGreaterThan(0)).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(0.17))
    ),
  }).pipe(
    Schema.withDecodingDefaultKey(
      Effect.succeed({ polygon: null, max_radius_m: 0.17 })
    )
  ),
  /** Height above the table a move stops at before descending onto something. */
  approach_height_m: Metres.check(Schema.isGreaterThan(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0.05))
  ),
  /** Table plane in the base frame (the profile's table_z_m). */
  table_z_m: Metres.pipe(Schema.withDecodingDefaultKey(Effect.succeed(-0.054))),
  /**
   * The motor owner refuses a pose whose arm geometry comes within this of
   * the table (the profile's link_radius_m); the tools fence the gripper
   * frame above it rather than have the move refused.
   */
  table_clearance_m: Metres.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0.015))
  ),
  /** Maps workspace-camera pixel (u, v, 1) to table (x, y, w), metres; null = uncalibrated. */
  workspace_table_homography: Schema.NullOr(Schema.Tuple([Row, Row, Row])).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  /** Wrist-camera pixel that lies between the jaws; null = unmeasured. */
  wrist_grasp_point_px: Schema.NullOr(
    Schema.Struct({ x: Schema.Finite, y: Schema.Finite })
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
});
export type ManipulationConfig = typeof ManipulationConfig.Type;

export const decodeManipulationConfig = (raw: unknown): ManipulationConfig =>
  Schema.decodeUnknownSync(ManipulationConfig, { onExcessProperty: "error" })(
    raw
  );

export const defaultManipulationPath = resolve(
  import.meta.dir,
  "../../../config/manipulation.lab-pi.json"
);

export type ManipulationLoad =
  | {
      readonly status: "loaded";
      readonly path: string;
      readonly config: ManipulationConfig;
    }
  | { readonly status: "absent"; readonly path: string }
  | {
      readonly status: "invalid";
      readonly path: string;
      readonly error: string;
    };

/**
 * Read the file named by ROBO_MANIPULATION_CONFIG (default
 * config/manipulation.lab-pi.json). Read on every call so an edited file
 * applies to the next chat without a restart. An invalid file is reported,
 * never half-applied.
 */
export const loadManipulationConfig = (
  path = process.env["ROBO_MANIPULATION_CONFIG"] || defaultManipulationPath
): ManipulationLoad => {
  if (!existsSync(path)) return { status: "absent", path };
  try {
    return {
      status: "loaded",
      path,
      config: decodeManipulationConfig(JSON.parse(readFileSync(path, "utf-8"))),
    };
  } catch (error) {
    return {
      status: "invalid",
      path,
      error:
        error instanceof Error ? error.message.slice(0, 500) : String(error),
    };
  }
};

/** Table (x, y) in metres for a workspace-camera pixel, or null when uncalibrated. */
export const pixelToTable = (
  homography: ManipulationConfig["workspace_table_homography"],
  u: number,
  v: number
): readonly [number, number] | null => {
  if (!homography) return null;
  const [a, b, c] = homography;
  const w = c[0] * u + c[1] * v + c[2];
  if (Math.abs(w) < 1e-9) return null;
  return [(a[0] * u + a[1] * v + a[2]) / w, (b[0] * u + b[1] * v + b[2]) / w];
};

/** Whether (x, y) lies inside a polygon (ray casting; edges count as outside). */
export const insidePolygon = (
  polygon: readonly (readonly [number, number])[],
  x: number,
  y: number
) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i] ?? [0, 0];
    const [xj, yj] = polygon[j] ?? [0, 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};
