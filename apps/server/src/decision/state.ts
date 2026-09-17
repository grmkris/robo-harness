import type { Observation } from "@robo/domain";

import { freshness, remaining, type Action, type Limits } from "./candidates";
import type { ResolvedTask, TrackerView } from "./tasks";

/** Frozen wording. Bump whenever instructions, questions or state shape change. */
export const QUESTION_VERSION = "decision/v2";

export interface PreviousStep {
  readonly action_id: string | null;
  readonly verdict: string | null;
  readonly outcome: string | null;
  readonly measured_change: Readonly<Record<string, number>> | null;
}

export const noPrevious: PreviousStep = {
  action_id: null,
  verdict: null,
  outcome: null,
  measured_change: null,
};

interface Progress {
  readonly step: number;
  readonly max_steps: number;
  readonly executed: number;
  readonly completed: number;
  readonly consecutive_failures: number;
}

/** Text-only evidence from perception, kept in its own (pixel) frame. */
export interface Detection {
  readonly source: string;
  readonly camera: string;
  readonly frame_age_ms: number | null;
  readonly [key: string]: unknown;
}

export interface DecisionState {
  readonly question_version: string;
  readonly task: {
    readonly name: string;
    readonly description: string;
    readonly phase: string;
    readonly stage: number;
    readonly stages: number;
    readonly instruction: string | null;
    readonly goal: Readonly<Record<string, number>>;
    readonly remaining: Readonly<Record<string, number>>;
    /** True only when the whole task is complete. */
    readonly reached: boolean;
    readonly metrics: Readonly<Record<string, unknown>>;
  };
  readonly robot: {
    readonly backend: string;
    readonly measured: Observation["measured"];
    readonly fault: string | null;
    readonly control_owner: string | null;
    readonly motion_in_progress: boolean;
    readonly observation_seq: number;
  };
  readonly freshness: ReturnType<typeof freshness>;
  readonly detections: readonly Detection[];
  readonly previous: PreviousStep;
  readonly progress: Progress;
}

export interface StateInput {
  readonly obs: Observation;
  readonly task: ResolvedTask;
  readonly view: TrackerView;
  readonly limits: Limits;
  readonly previous: PreviousStep;
  readonly progress: Progress;
  readonly detections?: readonly Detection[];
}

export const decisionState = (input: StateInput): DecisionState => ({
  question_version: QUESTION_VERSION,
  task: {
    name: input.task.name,
    description: input.task.description,
    phase: input.view.phase,
    stage: input.view.stage,
    stages: input.view.stages,
    instruction: input.view.instruction,
    goal: input.view.goal,
    remaining: remaining(input.obs, input.view.goal),
    reached: input.view.complete,
    metrics: input.view.metrics,
  },
  robot: {
    backend: input.obs.backend,
    measured: input.obs.measured,
    fault: input.obs.fault,
    control_owner: input.obs.operator?.owner ?? null,
    motion_in_progress:
      input.obs.operation?.status === "accepted" ||
      input.obs.operation?.status === "running",
    observation_seq: input.obs.seq,
  },
  freshness: freshness(input.obs, input.limits),
  detections: input.detections ?? [],
  previous: input.previous,
  progress: input.progress,
});

/** Candidate descriptions as Jev criteria: option ID → what it does. */
export const criteriaOf = (offered: readonly Action[]) =>
  Object.fromEntries(offered.map((action) => [action.id, action.description]));
