import { joints } from "@robo/domain";
import type { Joint } from "@robo/domain";
import type { ChoiceAnswer, WireQuestion } from "@tanstack/ai";

import type { Action, StepAction } from "./candidates";
import { booleanAnswer, choiceAnswer } from "./jev";
import type { Evaluator, Usage } from "./jev";
import { criteriaOf, type DecisionState } from "./state";

export const strategyNames = ["choice", "parallel", "critic", "rules"] as const;
export type StrategyName = (typeof strategyNames)[number];

export interface DecideInput {
  readonly state: DecisionState;
  readonly offered: readonly Action[];
  readonly signal: AbortSignal;
}

interface Decision {
  readonly action_id: string;
  readonly strategy: StrategyName;
  readonly model: string;
  /** The primary distribution, for analysis only; never physical authorization. */
  readonly probabilities: Readonly<Record<string, number>> | null;
  /** Validated raw answers per question. */
  readonly answers: unknown;
  readonly usage: Usage;
  readonly cost_usd: number;
  readonly latency_ms: number;
  readonly note: string | null;
}

export interface Decider {
  readonly strategy: StrategyName;
  readonly decide: (input: DecideInput) => Promise<Decision>;
}

const noUsage: Usage = { inputTokens: null, outputTokens: null };

const INSTRUCTIONS =
  "You select the next action for a real SO-101 robot arm from the supplied evidence. Motion is appropriate only when the observation is usable and a step makes progress on the task. Prefer reobserve for stale or missing data, stop for faults or repeated failures, and done only when the task is verifiably complete. A local controller independently validates and may refuse any motion.";

const isStep = (action: Action): action is StepAction => action.kind === "step";

/** Pickup metrics the rules baseline reads (written by the pickup tracker). */
interface PickupMetrics {
  readonly blob_visible?: boolean;
  readonly blob_dx?: number | null;
  readonly blob_dy?: number | null;
  readonly center_tolerance?: number;
  readonly blob_change_since_last_step?: {
    readonly dx: number;
    readonly dy: number;
  } | null;
}

const stepFor = (
  offered: readonly Action[],
  joint: Joint,
  sign: number
): string | null =>
  offered
    .filter(isStep)
    .find(
      (action) => action.joint === joint && Math.sign(action.delta) === sign
    )?.id ?? null;

/**
 * Visual servo baseline for the pickup phases: pan corrects image x, elbow
 * corrects image y. The direction is inferred from how the previous step on
 * the same joint moved the piece; without that it probes the positive side.
 */
const pickupRule = (input: DecideInput): string => {
  const { state, offered } = input;
  const m = state.task.metrics as PickupMetrics;
  const phase = state.task.phase;
  if (phase === "lift") {
    return stepFor(offered, "shoulder_lift", -1) ?? "stop";
  }
  if (
    !m.blob_visible ||
    m.blob_dx === null ||
    m.blob_dx === undefined ||
    m.blob_dy === null ||
    m.blob_dy === undefined
  ) {
    return state.previous.action_id === "reobserve" ? "stop" : "reobserve";
  }
  const tolerance = m.center_tolerance ?? 0.06;
  const dx = m.blob_dx;
  const dy = m.blob_dy;
  if (
    phase === "descend" &&
    Math.abs(dx) <= 2 * tolerance &&
    Math.abs(dy) <= 2 * tolerance
  ) {
    return stepFor(offered, "shoulder_lift", 1) ?? "stop";
  }
  const useX = Math.abs(dx) >= Math.abs(dy);
  const joint: Joint = useX ? "shoulder_pan" : "elbow_flex";
  const error = useX ? dx : dy;
  const previous = state.previous.action_id ?? "";
  const change = m.blob_change_since_last_step;
  let sign = 1;
  if (previous.startsWith(joint) && change) {
    const moved = useX ? change.dx : change.dy;
    const stepSign = previous.includes("-") ? -1 : 1;
    if (Math.abs(moved) > 0.005) {
      sign = -Math.sign(error) * Math.sign(moved) * stepSign;
    }
  }
  return (
    stepFor(offered, joint, sign) ??
    stepFor(offered, joint, -sign) ??
    "reobserve"
  );
};

/**
 * Rules baseline over the same state and candidates: stop on fault or repeated
 * failure; reobserve when unusable or right after a failed step; done when
 * reached; otherwise the toward-goal step with the largest remaining error.
 */
export const rulesChoice = (input: DecideInput): string => {
  const { state, offered } = input;
  if (
    ["center", "descend", "lift"].includes(state.task.phase) &&
    !state.robot.fault &&
    state.freshness.usable &&
    state.progress.consecutive_failures < 2 &&
    !state.task.reached
  ) {
    return pickupRule(input);
  }
  const lastStepFailed =
    state.previous.verdict === "valid" &&
    /^(?:failed|cancelled|refused)/u.test(state.previous.outcome ?? "");
  if (state.robot.fault || state.progress.consecutive_failures >= 2) {
    return "stop";
  }
  if (!state.freshness.usable || lastStepFailed) {
    return "reobserve";
  }
  if (state.task.reached) {
    return "done";
  }
  const left = state.task.remaining;
  const toward = offered
    .filter(isStep)
    .filter(
      (action) => Math.sign(action.delta) === Math.sign(left[action.joint] ?? 0)
    )
    .toSorted(
      (a, b) => Math.abs(left[b.joint] ?? 0) - Math.abs(left[a.joint] ?? 0)
    );
  return toward[0]?.id ?? (Object.keys(left).length > 0 ? "stop" : "reobserve");
};

export const rulesDecider = (): Decider => ({
  strategy: "rules",
  decide: (input) => {
    const started = performance.now();
    return Promise.resolve({
      action_id: rulesChoice(input),
      strategy: "rules",
      model: "rules/v1",
      probabilities: null,
      answers: {},
      usage: noUsage,
      cost_usd: 0,
      latency_ms: Math.round(performance.now() - started),
      note: null,
    });
  },
});

/** A: one Choice over every complete candidate action. */
export const choiceDecider = (evaluate: Evaluator): Decider => ({
  strategy: "choice",
  decide: async ({ state, offered, signal }) => {
    const ids = offered.map((action) => action.id);
    const outcome = await evaluate({
      state,
      questions: {
        nextAction: {
          type: "choice",
          instructions: INSTRUCTIONS,
          criteria: criteriaOf(offered),
        },
      },
      signal,
    });
    const answer = choiceAnswer(outcome.answers["nextAction"], ids);
    return {
      action_id: answer.value,
      strategy: "choice",
      model: outcome.model,
      probabilities: answer.probabilities,
      answers: { nextAction: answer },
      usage: outcome.usage,
      cost_usd: outcome.cost_usd,
      latency_ms: outcome.latency_ms,
      note: null,
    };
  },
});

interface ParallelAnswers {
  terminate: ChoiceAnswer;
  act: number;
  joint: ChoiceAnswer | null;
  direction: ChoiceAnswer | null;
}

const terminateOptions = {
  continue: "Keep working on the task.",
  done: "The task is verifiably complete; end the run.",
  stop: "Something is wrong (fault, repeated failure, unsafe); end the run and hold.",
};

/**
 * B: Doom-style parallel questions answered in one request. Code composes the
 * answers into one offered step; anything that does not map to an offered
 * candidate becomes reobserve.
 */
const parallelDecider = (evaluate: Evaluator): Decider => ({
  strategy: "parallel",
  decide: async ({ state, offered, signal }) => {
    const steps = offered.filter(isStep);
    const movable = joints.filter((joint) =>
      steps.some((action) => action.joint === joint)
    );
    const questions: Record<string, WireQuestion> = {};
    const add = (id: string, question: WireQuestion) => {
      Object.assign(questions, { [id]: question });
    };
    add("terminate", {
      type: "choice",
      instructions: `${INSTRUCTIONS} Should the run continue, finish, or stop?`,
      criteria: terminateOptions,
    });
    add("act", {
      type: "noul",
      instructions:
        "Is the current observation usable and is a motion step appropriate right now?",
      criteria: {
        true: "Fresh, fault-free evidence and useful progress is available.",
        false:
          "Data is stale or missing, the robot is busy, or the last step failed.",
      },
    });
    if (movable.length > 0) {
      add("joint", {
        type: "choice",
        instructions:
          "Which joint should move next to make progress on the task?",
        criteria: Object.fromEntries(
          movable.map((joint) => [
            joint,
            `remaining ${state.task.remaining[joint] ?? "n/a"}`,
          ])
        ),
      });
      add("direction", {
        type: "choice",
        instructions: "Which direction should that joint move?",
        criteria: {
          increase: "Increase the joint value (positive step).",
          decrease: "Decrease the joint value (negative step).",
        },
      });
    }
    const outcome = await evaluate({ state, questions, signal });
    const terminate = choiceAnswer(
      outcome.answers["terminate"],
      Object.keys(terminateOptions)
    );
    const act = booleanAnswer(outcome.answers["act"]);
    const answers: ParallelAnswers = {
      terminate,
      act,
      joint: null,
      direction: null,
    };
    let actionId = "reobserve";
    let note: string | null = null;
    if (terminate.value !== "continue") {
      actionId = terminate.value;
    } else if (act >= 0.5 && movable.length > 0) {
      const joint = choiceAnswer(outcome.answers["joint"], movable);
      const direction = choiceAnswer(outcome.answers["direction"], [
        "increase",
        "decrease",
      ]);
      answers.joint = joint;
      answers.direction = direction;
      const sign = direction.value === "increase" ? 1 : -1;
      const match = steps.find(
        (action) =>
          action.joint === (joint.value as Joint) &&
          Math.sign(action.delta) === sign
      );
      if (match) {
        actionId = match.id;
      } else {
        note = `composition miss: ${joint.value} ${direction.value} is not offered`;
      }
    } else if (act < 0.5) {
      note = "act < 0.5";
    }
    return {
      action_id: actionId,
      strategy: "parallel",
      model: outcome.model,
      probabilities: terminate.probabilities,
      answers,
      usage: outcome.usage,
      cost_usd: outcome.cost_usd,
      latency_ms: outcome.latency_ms,
      note,
    };
  },
});

/**
 * C: the rules baseline proposes; Jev booleans can veto a motion or a "done".
 * A veto becomes reobserve, never a different motion.
 */
const criticDecider = (evaluate: Evaluator): Decider => ({
  strategy: "critic",
  decide: async (input) => {
    const proposal = rulesChoice(input);
    const proposed = input.offered.find((action) => action.id === proposal);
    if (
      !proposed ||
      proposed.kind === "reobserve" ||
      proposed.kind === "wait" ||
      proposed.kind === "stop"
    ) {
      return {
        ...(await rulesDecider().decide(input)),
        strategy: "critic",
        note: "no review needed",
      };
    }
    const outcome = await evaluate({
      state: {
        ...input.state,
        proposed_action: { id: proposed.id, description: proposed.description },
      },
      questions: {
        safe: {
          type: "noul",
          instructions:
            "Given the evidence, is executing the proposed action now safe and useful for the task?",
          criteria: {
            true: "Evidence is fresh and the action makes progress without apparent risk.",
            false:
              "Evidence is stale or contradictory, the action would not help, or it looks unsafe.",
          },
        },
        complete: {
          type: "noul",
          instructions: "Is the task already verifiably complete?",
        },
      },
      signal: input.signal,
    });
    const safe = booleanAnswer(outcome.answers["safe"]);
    const complete = booleanAnswer(outcome.answers["complete"]);
    const vetoed = proposed.kind === "done" ? complete < 0.5 : safe < 0.5;
    return {
      action_id: vetoed ? "reobserve" : proposed.id,
      strategy: "critic",
      model: outcome.model,
      probabilities: { safe, complete },
      answers: { proposal, safe, complete },
      usage: outcome.usage,
      cost_usd: outcome.cost_usd,
      latency_ms: outcome.latency_ms,
      note: vetoed ? `vetoed ${proposed.id}` : `approved ${proposed.id}`,
    };
  },
});

export const deciderFor = (
  strategy: StrategyName,
  evaluate: Evaluator
): Decider => {
  switch (strategy) {
    case "choice": {
      return choiceDecider(evaluate);
    }
    case "parallel": {
      return parallelDecider(evaluate);
    }
    case "critic": {
      return criticDecider(evaluate);
    }
    case "rules": {
      return rulesDecider();
    }
  }
};
