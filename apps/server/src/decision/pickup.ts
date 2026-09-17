import type { Joint, Observation } from "@robo/domain";

import type { Goal } from "./candidates";
import type { Detection } from "./state";
import type { StepOutcome, TaskTracker, TrackerView } from "./tasks";

export interface PickupConfig {
  /** Reviewed joint pose above the piece (gripper pointing down). */
  readonly hover: Goal;
  /** Model gripper-frame z (m) to descend to before closing. */
  readonly graspZ: number;
  /** Lift this far above graspZ with the piece held to finish. */
  readonly liftHeightM: number;
  /** Where the piece appears in the wrist image when it sits between the jaws, blob coordinates. */
  readonly graspPoint: { readonly x: number; readonly y: number };
  readonly openPercent: number;
  /** A blocked close holding at or above this gripper reading counts as contact. */
  readonly heldPercent: number;
  /** Ordinary lag on an open gripper is not contact: only closes that stall below this count. */
  readonly contactMaxPercent: number;
  readonly centerTolerance: number;
  readonly hoverToleranceDeg: number;
  readonly maxEmptyCloses: number;
}

export const pickupDefaults = {
  liftHeightM: 0.05,
  graspPoint: { x: -0.16, y: 0.09 },
  openPercent: 55,
  heldPercent: 4,
  contactMaxPercent: 35,
  centerTolerance: 0.06,
  hoverToleranceDeg: 1.5,
  maxEmptyCloses: 2,
} as const;

const phases = [
  "open",
  "approach",
  "center",
  "descend",
  "grasp",
  "lift",
] as const;
type Phase = (typeof phases)[number];

const arm: readonly Joint[] = [
  "shoulder_pan",
  "shoulder_lift",
  "elbow_flex",
  "wrist_flex",
  "gripper",
];

const instructions: Record<Phase, string> = {
  open: "Open the gripper to the reference opening before moving toward the piece.",
  approach:
    "Move the arm toward the reference hover pose above the piece; the remaining joint differences show what is left.",
  center:
    "Centre the piece at the grasp point in the wrist camera: drive blob_dx and blob_dy toward 0. blob_change_since_last_step shows how the previous joint step moved the piece in the image.",
  descend:
    "Lower the gripper toward target_z while keeping blob_dx and blob_dy near 0. Lower z means closer to the mat.",
  grasp:
    "Close the gripper on the piece. A close that stops short because the piece is between the jaws is expected.",
  lift: "Raise the gripper to target_z while holding the piece.",
};

const round = (value: number) => Math.round(value * 1000) / 1000;

interface Blob {
  readonly x: number;
  readonly y: number;
}

const blobOf = (detections: readonly Detection[]): Blob | null => {
  const blob = detections.find((d) => d.source === "white-blob/v1");
  const x = blob?.["center_x"];
  const y = blob?.["center_y"];
  return blob?.["visible"] === true &&
    typeof x === "number" &&
    typeof y === "number"
    ? { x, y }
    : null;
};

/**
 * Phase machine for picking up the white piece. Transitions are checked in
 * code from measured joints, the model end effector and the wrist blob; the
 * decider only chooses bounded steps. A close with no contact reopens and
 * retries, up to maxEmptyCloses.
 */
export const pickupTracker = (config: PickupConfig): TaskTracker => {
  let index = 0;
  let contact = false;
  let emptyCloses = 0;
  let blobAtLastStep: Blob | null = null;
  let lastBlob: Blob | null = null;
  const liftZ = config.graspZ + config.liftHeightM;

  const phase = (): Phase =>
    phases[Math.min(index, phases.length - 1)] ?? "open";

  const advance = (
    obs: Observation,
    detections: readonly Detection[]
  ): TrackerView => {
    const blob = blobOf(detections);
    const eeZ = obs.ee[2] ?? Number.NaN;
    const holding = contact && obs.measured.gripper >= config.heldPercent;
    const transitions: Record<string, unknown>[] = [];
    let failed: string | null = null;
    const done = (): boolean => {
      switch (phase()) {
        case "open": {
          return obs.measured.gripper >= config.openPercent - 2;
        }
        case "approach": {
          return Object.entries(config.hover).every(
            ([joint, target]) =>
              Math.abs(obs.measured[joint as Joint] - target) <=
              config.hoverToleranceDeg
          );
        }
        case "center": {
          return (
            blob !== null &&
            Math.abs(blob.x - config.graspPoint.x) <= config.centerTolerance &&
            Math.abs(blob.y - config.graspPoint.y) <= config.centerTolerance
          );
        }
        case "descend": {
          return eeZ <= config.graspZ + 0.003;
        }
        case "grasp": {
          return contact;
        }
        case "lift": {
          return eeZ >= liftZ && holding;
        }
      }
    };
    while (index < phases.length && done()) {
      transitions.push({ phase: phase() });
      index += 1;
    }
    if (
      phase() === "grasp" &&
      !contact &&
      obs.measured.gripper <= config.heldPercent - 2
    ) {
      emptyCloses += 1;
      transitions.push({
        phase: "grasp",
        result: "closed empty",
        attempt: emptyCloses,
      });
      if (emptyCloses >= config.maxEmptyCloses) {
        failed = `gripper closed empty ${emptyCloses} times`;
      } else {
        index = phases.indexOf("open");
      }
    }
    const complete = index >= phases.length;
    const current = phase();
    const goal: Goal =
      current === "open"
        ? { gripper: config.openPercent }
        : current === "approach"
          ? config.hover
          : current === "grasp"
            ? { gripper: 0 }
            : {};
    const blobChange =
      blob && blobAtLastStep
        ? {
            dx: round(blob.x - blobAtLastStep.x),
            dy: round(blob.y - blobAtLastStep.y),
          }
        : null;
    lastBlob = blob;
    return {
      phase: complete ? "done" : current,
      stage: Math.min(index + 1, phases.length),
      stages: phases.length,
      instruction: complete ? null : instructions[current],
      goal: complete ? {} : goal,
      explore: arm,
      complete,
      failed,
      reachedCount: index,
      transitions,
      metrics: {
        ee_xyz_m: obs.ee.slice(0, 3).map(round),
        target_z_m:
          current === "descend"
            ? config.graspZ
            : current === "lift"
              ? round(liftZ)
              : null,
        blob_visible: blob !== null,
        blob_dx: blob ? round(blob.x - config.graspPoint.x) : null,
        blob_dy: blob ? round(blob.y - config.graspPoint.y) : null,
        blob_change_since_last_step: blobChange,
        grasp_point: config.graspPoint,
        center_tolerance: config.centerTolerance,
        gripper_contact: contact,
        holding,
        empty_closes: emptyCloses,
      },
    };
  };

  const onStep = (outcome: StepOutcome) => {
    blobAtLastStep = lastBlob;
    const { action, after, status } = outcome;
    if (
      phase() === "grasp" &&
      action.joint === "gripper" &&
      action.delta < 0 &&
      after &&
      lastBlob !== null &&
      after.measured.gripper >= config.heldPercent &&
      after.measured.gripper <= config.contactMaxPercent &&
      after.measured.gripper > action.target + 1.5
    ) {
      contact = true;
      return {
        expected: status !== "completed",
        note: `gripper stopped at ${round(after.measured.gripper)} short of ${action.target}: contact`,
      };
    }
    return { expected: false, note: null };
  };

  return { advance, onStep };
};
