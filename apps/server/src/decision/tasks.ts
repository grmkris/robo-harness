import { joints } from "@robo/domain";
import type { Joint, Observation } from "@robo/domain";
import { Schema } from "effect";

import type { CandidateSpec, Goal } from "./candidates";

export const TaskName = Schema.Literals([
  "control-smoke",
  "pickup-white-piece",
]);
export type TaskName = typeof TaskName.Type;

/** A task resolved against the observation at run start; goals are frozen then. */
export interface ResolvedTask {
  readonly name: TaskName;
  readonly description: string;
  /** Ordered goal poses; the run advances to the next stage when one is reached. */
  readonly stages: readonly Goal[];
  readonly explore: readonly Joint[];
  readonly start: Observation["measured"];
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const isJoint = (value: string): value is Joint =>
  joints.some((joint) => joint === value);

/**
 * Parse `joint+=4`, `joint-=2` (relative to the start pose) and `joint=-8.5`
 * (absolute; a sign after a plain "=" is part of the value). Every target must
 * lie inside the commissioned limits.
 */
export const parseGoal = (spec: string, obs: Observation): Goal => {
  const goal: Partial<Record<Joint, number>> = {};
  for (const part of spec.split(",")) {
    const match =
      /^(?<joint>[a-z_]+)(?<op>\+=|-=|=)(?<value>-?\d+(?:\.\d+)?)$/u.exec(
        part.trim()
      );
    const joint = match?.groups?.["joint"] ?? "";
    if (!match?.groups || !isJoint(joint)) {
      throw new Error(
        `Bad goal "${part}"; use joint+=4 / joint-=4 (relative) or joint=-8.5 (absolute)`
      );
    }
    const op = match.groups["op"];
    const value = Number(match.groups["value"]);
    const target = round(
      op === "+="
        ? obs.measured[joint] + value
        : op === "-="
          ? obs.measured[joint] - value
          : value
    );
    const [low, high] = obs.limits[joint];
    if (target < low || target > high) {
      throw new Error(
        `Goal ${joint}=${target} is outside the commissioned range ${low}..${high}`
      );
    }
    goal[joint] = target;
  }
  return goal;
};

export const resolveTask = (
  name: TaskName,
  obs: Observation,
  goal?: string
): ResolvedTask => {
  const start = obs.measured;
  if (name === "pickup-white-piece") {
    return {
      name,
      description:
        "Grasp the white piece on the black mat using the wrist camera detection: centre it, descend, close the gripper, and confirm the grasp. Pixel offsets are image coordinates, not robot coordinates.",
      stages: goal ? [parseGoal(goal, obs)] : [],
      explore: [
        "shoulder_pan",
        "shoulder_lift",
        "elbow_flex",
        "wrist_flex",
        "gripper",
      ],
      start,
    };
  }
  const stages = goal
    ? [parseGoal(goal, obs)]
    : [
        parseGoal("gripper+=4", obs),
        parseGoal("wrist_flex+=2", obs),
        { wrist_flex: start.wrist_flex },
      ];
  return {
    name,
    description:
      "Reach each goal joint pose in order using only the offered bounded steps. No object is involved.",
    stages,
    explore: [],
    start,
  };
};

export const specFor = (task: ResolvedTask, stage: number): CandidateSpec => ({
  goal: task.stages[stage] ?? {},
  explore: task.explore,
});
