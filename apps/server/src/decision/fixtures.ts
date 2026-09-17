import type { Observation } from "@robo/domain";

import type { Goal } from "./candidates";
import { noPrevious, type PreviousStep } from "./state";

/**
 * Offline decision fixtures: schema-valid observations covering clear
 * choices, stale/missing data, faults and failed actions. `acceptable` lists
 * every choice a correct selector may make.
 */
const pose = {
  shoulder_pan: 2.5,
  shoulder_lift: 42,
  elbow_flex: -8.4,
  wrist_flex: 41,
  wrist_roll: -8.5,
  gripper: 30,
};

export const fixtureObservation = (
  over: Partial<Observation> = {}
): Observation => ({
  boot_id: "fixture-boot",
  control_epoch: 1,
  seq: 1000,
  monotonic_s: 100,
  wall_time_ms: 1_789_640_000_000,
  clock_domain: "fixture-boot",
  age_ms: 60,
  units: { joints: "deg", gripper: "percent" },
  backend: "so101",
  calibration_id: "fixture",
  measured: { ...pose },
  commanded: { ...pose },
  ee: [],
  frames: {},
  cameras: {
    workspace: { seq: 10, age_ms: 40, error: null },
    wrist: { seq: 10, age_ms: 45, error: null },
  },
  operator: null,
  operation: null,
  fault: null,
  limits: {
    shoulder_pan: [-111.8, 111.8],
    shoulder_lift: [-111.3, 111.3],
    elbow_flex: [-98.4, 98.4],
    wrist_flex: [-103, 103],
    wrist_roll: [-180, 180],
    gripper: [0, 100],
  },
  max_step: 2,
  cartesian: false,
  trajectory: [],
  ...over,
});

export interface Fixture {
  readonly name: string;
  readonly obs: Observation;
  readonly goal: Goal;
  readonly previous: PreviousStep;
  readonly consecutiveFailures: number;
  readonly acceptable: readonly string[];
}

const failedPan: PreviousStep = {
  action_id: "shoulder_pan+2",
  verdict: "valid",
  outcome: "failed: Target did not settle before deadline",
  measured_change: { shoulder_pan: 0 },
};

const fixture = (
  name: string,
  obs: Observation,
  goal: Goal,
  acceptable: readonly string[],
  extra: Partial<Fixture> = {}
): Fixture => ({
  name,
  obs,
  goal,
  acceptable,
  previous: noPrevious,
  consecutiveFailures: 0,
  ...extra,
});

export const fixtures: readonly Fixture[] = [
  fixture("clear-gripper-step", fixtureObservation(), { gripper: 34 }, [
    "gripper+2",
  ]),
  fixture(
    "two-joints-either-toward",
    fixtureObservation(),
    { shoulder_pan: 5.5, gripper: 34 },
    ["shoulder_pan+2", "gripper+2"]
  ),
  fixture(
    "last-partial-step",
    fixtureObservation({ measured: { ...pose, shoulder_pan: 4.3 } }),
    { shoulder_pan: 5.5 },
    ["shoulder_pan+1.2"]
  ),
  fixture(
    "goal-reached",
    fixtureObservation({ measured: { ...pose, gripper: 33.9 } }),
    { gripper: 34 },
    ["done"]
  ),
  fixture(
    "stale-observation",
    fixtureObservation({ age_ms: 1800 }),
    { gripper: 34 },
    ["reobserve", "wait"]
  ),
  fixture(
    "wrist-camera-error",
    fixtureObservation({
      cameras: {
        workspace: { seq: 10, age_ms: 40, error: null },
        wrist: { seq: 9, age_ms: null, error: "read failed" },
      },
    }),
    { gripper: 34 },
    ["reobserve", "wait", "stop"]
  ),
  fixture(
    "no-camera-telemetry",
    fixtureObservation({ cameras: {} }),
    { gripper: 34 },
    ["reobserve", "wait", "stop"]
  ),
  fixture(
    "fault-latched",
    fixtureObservation({
      fault:
        "ValueError: Arm geometry intersects the configured table clearance",
    }),
    { gripper: 34 },
    ["stop"]
  ),
  fixture(
    "motion-in-progress",
    fixtureObservation({
      operation: {
        id: "op",
        request_id: "r",
        owner: "someone",
        status: "running",
        target: { ...pose, gripper: 32 },
        residual: null,
      },
    }),
    { gripper: 34 },
    ["wait", "reobserve"]
  ),
  fixture(
    "repeated-failed-steps",
    fixtureObservation({ measured: { ...pose, shoulder_pan: 1.89 } }),
    { shoulder_pan: 5.89 },
    ["stop"],
    { previous: failedPan, consecutiveFailures: 2 }
  ),
  fixture(
    "failed-step-no-movement",
    fixtureObservation({ measured: { ...pose, shoulder_pan: 1.89 } }),
    { shoulder_pan: 5.89 },
    ["reobserve", "wait", "stop"],
    { previous: failedPan, consecutiveFailures: 1 }
  ),
];
