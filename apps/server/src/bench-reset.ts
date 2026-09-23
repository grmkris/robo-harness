/** Scripted fixture operator. Never offered as a tool or instruction to a model. */
import { Schema } from "effect";

import { resetDecision } from "./bench-judge";
import { insidePolygon, type ManipulationConfig } from "./manipulation-config";
import type { manipulationSchemas } from "./manipulation-tools";

type Point = readonly [number, number];
type Phase = "pick" | "place";
type MotionName = "home" | "gripper" | "move_tcp" | "descend_until_contact";
type MotionInput = {
  [K in MotionName]: (typeof manipulationSchemas)[K]["Type"];
};
const MotionResult = Schema.Struct({
  reached: Schema.Boolean,
  status: Schema.optionalKey(
    Schema.Literals([
      "completed",
      "failed",
      "cancelled",
      "unknown",
      "accepted",
      "running",
    ])
  ),
  contact: Schema.optionalKey(Schema.Boolean),
  stalled_at: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  stopped: Schema.optionalKey(Schema.String),
});

interface Location {
  readonly xy_m: Point;
  readonly frame_id: string;
  /** A verified table object, not merely a bright candidate or an inferred depth. */
  readonly on_table: boolean;
}

export interface ResetIO {
  /** Adapter must use executeManipulationTool and its shared supervised executor. */
  readonly motion: <K extends MotionName>(
    name: K,
    input: MotionInput[K],
    signal: AbortSignal
  ) => Promise<unknown>;
  /** Fresh workspace CC + segmentation, or null if uncertain/ambiguous. */
  readonly locate: (signal: AbortSignal) => Promise<Location | null>;
  /** A non-settling descent alone cannot distinguish contact from a servo failure. */
  readonly confirmContact: (
    phase: Phase,
    signal: AbortSignal
  ) => Promise<boolean | null>;
  /** Both cameras + SAM: object in jaws and original table spot empty. */
  readonly verifyHeld: (signal: AbortSignal) => Promise<boolean | null>;
}

class ResetStop extends Error {}

/**
 * Closed-loop reset, unscored. Each adapter call is awaited; no static trajectory
 * continues past a failed or unknown result. Wiring/admission belongs to the
 * coordinator; this module has no live adapter or credentials.
 */
export const resetObject = async (
  config: ManipulationConfig,
  target: Point,
  io: ResetIO,
  signal: AbortSignal
) => {
  let attempts = 0;
  let lastFrame: string | null = null;
  const events: { phase: string; detail: string }[] = [];
  const checked = async <K extends MotionName>(
    name: K,
    input: MotionInput[K]
  ) => {
    signal.throwIfAborted();
    const result = Schema.decodeUnknownSync(MotionResult)(
      await io.motion(name, input, signal)
    );
    signal.throwIfAborted();
    events.push({
      phase: name,
      detail: result.status ?? (result.reached ? "reached" : "incomplete"),
    });
    // Failed descent/closing can be a contact signature. Only those callers
    // may interpret it, with independent visual verification before proceeding.
    if (
      result.status === "unknown" ||
      result.status === "cancelled" ||
      result.status === "accepted" ||
      result.status === "running"
    ) {
      throw new ResetStop(`${name}: motion outcome ${result.status}`);
    }
    return result;
  };
  const reached = async <K extends MotionName>(
    name: K,
    input: MotionInput[K]
  ) => {
    const result = await checked(name, input);
    if (!result.reached || result.status === "failed")
      throw new ResetStop(`${name}: first failed motion`);
    return result;
  };
  const fence = (point: Point) => {
    if (
      !point.every(Number.isFinite) ||
      !config.safe_zone.polygon ||
      !insidePolygon(config.safe_zone.polygon, ...point) ||
      Math.hypot(...point) > Math.min(0.17, config.safe_zone.max_radius_m)
    ) {
      throw new ResetStop(
        "Object or target is outside the commissioned reset area"
      );
    }
  };
  const locate = async () => {
    signal.throwIfAborted();
    const location = await io.locate(signal);
    signal.throwIfAborted();
    if (
      !location?.on_table ||
      !location.frame_id ||
      location.frame_id === lastFrame
    ) {
      throw new ResetStop("Reset needs a new verified table observation");
    }
    lastFrame = location.frame_id;
    fence(location.xy_m);
    return location;
  };
  const approachZ = config.table_z_m + Math.max(0.05, config.approach_height_m);
  const moveAbove = (point: Point) =>
    reached("move_tcp", { x: point[0], y: point[1], z: approachZ });
  const contact = async (phase: Phase) => {
    const result = await checked("descend_until_contact", {
      max_dz: Math.max(0.05, config.approach_height_m),
    });
    if (
      result.status !== "failed" ||
      result.contact !== true ||
      result.stopped !== "first_failed_step"
    ) {
      throw new ResetStop(`${phase}: descent did not establish contact`);
    }
    if ((await io.confirmContact(phase, signal)) !== true) {
      throw new ResetStop(`${phase}: contact is not visually confirmed`);
    }
    signal.throwIfAborted();
  };
  try {
    signal.throwIfAborted();
    if (
      !config.commissioned ||
      !config.home_pose ||
      (
        [
          "shoulder_pan",
          "shoulder_lift",
          "elbow_flex",
          "wrist_flex",
          "wrist_roll",
        ] as const
      ).some((joint) => !Number.isFinite(config.home_pose?.[joint])) ||
      !config.workspace_table_homography ||
      config.tcp_offset_m.every((value) => value === 0) ||
      config.approach_height_m > 0.15
    ) {
      throw new ResetStop(
        "Reset is gated on commissioned TCP, homography and home"
      );
    }
    fence(target);
    let location = await locate();
    for (; attempts < 3;) {
      const decision = resetDecision({
        attempts,
        max_attempts: 3,
        current_xy_m: location.xy_m,
        target_xy_m: target,
      });
      if (decision === "already_in_place") {
        await reached("home", {});
        return {
          status: "completed" as const,
          attempts,
          events,
          final_xy_m: location.xy_m,
        };
      }
      attempts += 1;
      await reached("home", {});
      await reached("gripper", { percent: 90 });
      await moveAbove(location.xy_m);
      const aligned = await locate();
      if (
        Math.hypot(
          aligned.xy_m[0] - location.xy_m[0],
          aligned.xy_m[1] - location.xy_m[1]
        ) > 0.005
      ) {
        events.push({
          phase: "alignment",
          detail: "Object moved; reobserve before descending",
        });
        location = aligned;
        continue;
      }
      await contact("pick");
      const grip = await checked("gripper", { percent: 0 });
      if (
        grip.stalled_at === undefined ||
        grip.stalled_at === null ||
        grip.stalled_at <= 8 ||
        (grip.status === "failed" && grip.contact !== true)
      ) {
        throw new ResetStop(
          "Grasp has no mechanical resistance above 8 percent"
        );
      }
      await moveAbove(aligned.xy_m);
      if ((await io.verifyHeld(signal)) !== true)
        throw new ResetStop("Lift is not visually verified");
      await moveAbove(target);
      await contact("place");
      await reached("gripper", { percent: 90 });
      await moveAbove(target);
      await reached("home", {});
      location = await locate();
      if (
        resetDecision({
          attempts,
          max_attempts: 3,
          current_xy_m: location.xy_m,
          target_xy_m: target,
        }) === "already_in_place"
      ) {
        return {
          status: "completed" as const,
          attempts,
          events,
          final_xy_m: location.xy_m,
        };
      }
    }
    return {
      status: "paused" as const,
      attempts,
      events,
      reason: "Three reset attempts did not verify placement",
    };
  } catch (error) {
    return {
      status: "paused" as const,
      attempts,
      events,
      reason:
        error instanceof Error ? error.message : "Reset outcome is unknown",
    };
  }
};
