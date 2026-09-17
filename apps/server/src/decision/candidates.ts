import { joints } from "@robo/domain";
import type { Joint, Observation } from "@robo/domain";

/** Local caps applied before the shared executor re-validates every move. */
export interface Limits {
  /** Largest step per action (degrees, or gripper percent). Never above the robot's max_step. */
  readonly stepDeg: number;
  /** Local speed cap, units per second; sets each step's duration. */
  readonly speedPerS: number;
  /** Arm joints within this of a goal count as reached (the motor owner settles to 0.8). */
  readonly toleranceDeg: number;
  readonly gripperTolerance: number;
  readonly maxObservationAgeMs: number;
  readonly maxCameraAgeMs: number;
  /** Measured drift allowed between the decision's observation and execution. */
  readonly maxDriftDeg: number;
}

export const defaultLimits: Limits = {
  stepDeg: 2,
  speedPerS: 2,
  toleranceDeg: 0.8,
  gripperTolerance: 1,
  maxObservationAgeMs: 250,
  maxCameraAgeMs: 500,
  maxDriftDeg: 0.5,
};

export type Goal = Readonly<Partial<Record<Joint, number>>>;

const controlKinds = ["reobserve", "wait", "stop", "done"] as const;
type ControlKind = (typeof controlKinds)[number];

export interface StepAction {
  readonly id: string;
  readonly kind: "step";
  readonly joint: Joint;
  readonly delta: number;
  readonly target: number;
  readonly duration_s: number;
  readonly description: string;
}
interface ControlAction {
  readonly id: ControlKind;
  readonly kind: ControlKind;
  readonly description: string;
}
export type Action = StepAction | ControlAction;

interface CameraFreshness {
  readonly age_ms: number | null;
  readonly error: string | null;
  readonly fresh: boolean;
}
export interface Freshness {
  readonly usable: boolean;
  readonly observation_age_ms: number;
  readonly cameras: Readonly<Record<string, CameraFreshness>>;
  readonly problems: readonly string[];
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Headroom under the step cap for measurement jitter between decision and execution. */
const STEP_MARGIN = 0.2;

const tolerance = (joint: Joint, limits: Limits) =>
  joint === "gripper" ? limits.gripperTolerance : limits.toleranceDeg;

export const freshness = (obs: Observation, limits: Limits): Freshness => {
  const problems: string[] = [];
  if (obs.fault) {
    problems.push(`fault latched: ${obs.fault}`);
  }
  if (obs.age_ms > limits.maxObservationAgeMs) {
    problems.push(`observation ${Math.round(obs.age_ms)} ms old`);
  }
  const cameras: Record<string, CameraFreshness> = {};
  for (const [name, camera] of Object.entries(obs.cameras)) {
    const fresh =
      camera.error === null &&
      camera.age_ms !== null &&
      camera.age_ms <= limits.maxCameraAgeMs;
    cameras[name] = { age_ms: camera.age_ms, error: camera.error, fresh };
    if (!fresh) {
      problems.push(
        `camera ${name}: ${camera.error ?? `${Math.round(camera.age_ms ?? -1)} ms old`}`
      );
    }
  }
  if (Object.keys(obs.cameras).length === 0) {
    problems.push("no camera telemetry");
  }
  if (
    obs.operation &&
    (obs.operation.status === "accepted" || obs.operation.status === "running")
  ) {
    problems.push("a motion is already in progress");
  }
  return {
    usable: problems.length === 0,
    observation_age_ms: obs.age_ms,
    cameras,
    problems,
  };
};

export const remaining = (obs: Observation, goal: Goal): Goal => {
  const out: Partial<Record<Joint, number>> = {};
  for (const joint of joints) {
    const target = goal[joint];
    if (target !== undefined) {
      out[joint] = round(target - obs.measured[joint]);
    }
  }
  return out;
};

export const reached = (obs: Observation, goal: Goal, limits: Limits) =>
  joints.every((joint) => {
    const target = goal[joint];
    return (
      target === undefined ||
      Math.abs(target - obs.measured[joint]) <= tolerance(joint, limits)
    );
  });

const controlText: Record<ControlKind, string> = {
  reobserve:
    "Take a fresh observation before deciding; no motion. Use when data is stale, missing or contradictory.",
  wait: "Do nothing this cycle and observe again; no motion. Use when the robot is busy or recovering.",
  stop: "End the run and hold the current pose. Use on faults, repeated failures or anything unsafe.",
  done: "Declare the task complete and end the run; only when the goal is verifiably reached.",
};

export interface CandidateSpec {
  /** Joints with a target: offered one step toward and one step away. */
  readonly goal: Goal;
  /** Joints without a target (visual tasks): offered one step in each direction. */
  readonly explore: readonly Joint[];
}

const step = (
  obs: Observation,
  joint: Joint,
  delta: number,
  limits: Limits,
  note: string
): StepAction | null => {
  const [low, high] = obs.limits[joint];
  const target = round(obs.measured[joint] + delta);
  if (delta === 0 || target < low || target > high) {
    return null;
  }
  // Plan below the speed cap too, so the executor's fresh measurement cannot tip it over.
  const durationS =
    Math.ceil(Math.max(1, Math.abs(delta) / (limits.speedPerS * 0.9)) * 10) /
    10;
  const unit = joint === "gripper" ? "%" : "deg";
  const signed = `${delta > 0 ? "+" : ""}${round(delta)}`;
  return {
    id: `${joint}${signed}`,
    kind: "step",
    joint,
    delta: round(delta),
    target,
    duration_s: durationS,
    description: `Move ${joint} by ${signed} ${unit} over ${durationS} s${note}.`,
  };
};

/**
 * Complete, bounded candidate actions. Motion is offered only when the
 * observation is usable; control actions are always offered.
 */
export const candidates = (
  obs: Observation,
  spec: CandidateSpec,
  limits: Limits
): Action[] => {
  const out: Action[] = [];
  if (freshness(obs, limits).usable) {
    // A step is measured again from a fresher observation by the executor and the
    // motor owner (exactly <= max_step). Sensor jitter of ~0.1 unit would refuse a
    // full-size step, so candidates keep a margin.
    const size = Math.max(
      0.1,
      Math.min(limits.stepDeg, obs.max_step) - STEP_MARGIN
    );
    for (const joint of joints) {
      const target = spec.goal[joint];
      if (target !== undefined) {
        const left = target - obs.measured[joint];
        if (Math.abs(left) > tolerance(joint, limits)) {
          const sign = Math.sign(left);
          const toward = step(
            obs,
            joint,
            sign * Math.min(size, Math.abs(left)),
            limits,
            `, toward the goal (${round(left - sign * Math.min(size, Math.abs(left)))} left afterwards)`
          );
          const away = step(
            obs,
            joint,
            -sign * size,
            limits,
            ", away from the goal"
          );
          for (const action of [toward, away]) {
            if (action) out.push(action);
          }
        }
      } else if (spec.explore.includes(joint)) {
        for (const sign of [1, -1]) {
          const action = step(obs, joint, sign * size, limits, "");
          if (action) out.push(action);
        }
      }
    }
  }
  for (const kind of controlKinds) {
    out.push({ id: kind, kind, description: controlText[kind] });
  }
  return out;
};

export type Verdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate a chosen step against a fresh observation immediately before
 * execution, independently of what the model answered. The shared executor
 * and the motor owner check again.
 */
export const validate = (
  action: Action,
  offered: readonly Action[],
  basis: Observation,
  now: Observation,
  limits: Limits
): Verdict => {
  if (!offered.some((candidate) => candidate.id === action.id)) {
    return { ok: false, reason: "not an offered candidate" };
  }
  if (action.kind !== "step") {
    return { ok: true };
  }
  const fresh = freshness(now, limits);
  if (!fresh.usable) {
    return {
      ok: false,
      reason: `unusable observation: ${fresh.problems.join("; ")}`,
    };
  }
  if (now.boot_id !== basis.boot_id) {
    return { ok: false, reason: "motor service restarted since the decision" };
  }
  if (now.seq < basis.seq) {
    return { ok: false, reason: "observation went backwards" };
  }
  if (now.operator && now.operator.remaining_ms > 0) {
    return { ok: false, reason: `control owned by ${now.operator.owner}` };
  }
  for (const joint of joints) {
    if (
      Math.abs(now.measured[joint] - basis.measured[joint]) > limits.maxDriftDeg
    ) {
      return { ok: false, reason: `${joint} moved since the decision` };
    }
  }
  const [low, high] = now.limits[action.joint];
  if (action.target < low || action.target > high) {
    return {
      ok: false,
      reason: `${action.joint} target outside commissioned limits`,
    };
  }
  const delta = Math.abs(action.target - now.measured[action.joint]);
  if (delta > Math.min(limits.stepDeg, now.max_step) + 0.05) {
    return {
      ok: false,
      reason: `${action.joint} step ${round(delta)} exceeds the cap`,
    };
  }
  if (delta / action.duration_s > limits.speedPerS + 1e-6) {
    return { ok: false, reason: `${action.joint} step exceeds the speed cap` };
  }
  return { ok: true };
};
