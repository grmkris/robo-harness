import type { Joint, Observation } from "@robo/domain";

import { fixtureObservation } from "./fixtures";
import { position, tipFrame, type Vec3 } from "./kinematics";
import type { MoveOutcome } from "./skills";

type Limits = Readonly<Record<Joint, readonly [number, number]>>;

const simLimits: Limits = {
  shoulder_pan: [-111.8, 111.8],
  shoulder_lift: [-111.3, 111.3],
  elbow_flex: [-98.4, 98.4],
  wrist_flex: [-103, 103],
  wrist_roll: [-180, 180],
  gripper: [0, 100],
};

/** An upright object on the table, a cylinder around a vertical axis. */
interface SimObject {
  readonly x: number;
  readonly y: number;
  readonly radiusM: number;
  readonly heightM: number;
  /** Gripper percent at which the jaws meet it. */
  readonly widthPercent: number;
}

interface SimArmOptions {
  readonly start: Record<Joint, number>;
  /** Table plane in the base frame. */
  readonly tableZ: number;
  /**
   * Height above the table at which the gripper frame's jaws touch a surface.
   * The URDF gripper frame is not the fingertip; on the lab arm the jaws met
   * the mat with the frame about 1 cm up.
   */
  readonly jawReachM?: number;
  readonly objects?: readonly SimObject[];
  /** Move numbers (1-based) at which the motor owner stops for a stale camera. */
  readonly staleAt?: readonly number[];
  readonly limits?: Limits;
}

const STALE = "Motion cancelled: Camera observation is stale or unavailable";
const UNSETTLED = "Motion failed: Target did not settle before deadline";

/**
 * A simulated SO-101 for tests of code that drives the arm: joints reach their
 * targets instantly, the gripper frame follows the lab URDF, and the world
 * pushes back the way the real one did.
 *
 * - A move that would take the jaws below the table, or into the top of an
 *   object under them, does not settle and leaves the arm where it was: the
 *   motor owner fails a move whose residual stays above tolerance, and on the
 *   real arm that is how contact shows up.
 * - Closing the gripper around an object stalls at the object's width and the
 *   move does not settle; closing on nothing reaches the command.
 * - Listed moves come back as the motor owner's stale-camera protective stop.
 */
export const simArm = (options: SimArmOptions) => {
  const limits = options.limits ?? simLimits;
  const jawReach = options.jawReachM ?? 0.01;
  let measured = { ...options.start };
  let moves = 0;
  const log: {
    readonly target: Partial<Record<Joint, number>>;
    readonly status: string;
  }[] = [];
  const observe = (): Observation =>
    fixtureObservation({
      backend: "mock",
      measured: { ...measured },
      commanded: { ...measured },
      ee: position(tipFrame(measured)),
      limits,
    });
  /** Height of the surface under a gripper-frame (x, y). */
  const surfaceUnder = (x: number, y: number) => {
    let top = options.tableZ;
    for (const object of options.objects ?? []) {
      if (Math.hypot(x - object.x, y - object.y) <= object.radiusM) {
        top = Math.max(top, options.tableZ + object.heightM);
      }
    }
    return top;
  };
  const between = (tip: Vec3) =>
    (options.objects ?? []).find(
      (object) =>
        Math.hypot(tip[0] - object.x, tip[1] - object.y) <= object.radiusM &&
        tip[2] - jawReach <= options.tableZ + object.heightM
    ) ?? null;
  const move = async (
    target: Partial<Record<Joint, number>>
  ): Promise<MoveOutcome> => {
    moves += 1;
    const record = (status: string, outcome: MoveOutcome) => {
      log.push({ target, status });
      return outcome;
    };
    if (options.staleAt?.includes(moves)) {
      return record("stale", {
        status: "cancelled",
        after: observe(),
        message: STALE,
      });
    }
    const next = { ...measured, ...target };
    const before = position(tipFrame(measured));
    const tip = position(tipFrame(next));
    const floor = surfaceUnder(tip[0], tip[1]) + jawReach;
    if (tip[2] < floor - 0.0005 && tip[2] < before[2]) {
      return record("contact", {
        status: "failed",
        after: observe(),
        message: UNSETTLED,
      });
    }
    if (target.gripper !== undefined && target.gripper < measured.gripper) {
      const held = between(tip);
      if (held && target.gripper < held.widthPercent) {
        measured = {
          ...next,
          gripper: Math.min(measured.gripper, held.widthPercent),
        };
        return record("stalled", {
          status: "failed",
          after: observe(),
          message: UNSETTLED,
        });
      }
    }
    measured = next;
    return record("completed", {
      status: "completed",
      after: observe(),
      message: "Motion reached measured completion.",
    });
  };
  return {
    observe: async () => observe(),
    move,
    moves: () => moves,
    measured: () => ({ ...measured }),
    log: () => log,
  };
};
