import { joints } from "@robo/domain";
import type { Observation } from "@robo/domain";

import type {
  ActionRequest,
  ActionResult,
  MotionProgress,
} from "../motion-actions";
import { ToolFailure } from "../tool-errors";
import { candidates, validate, type Action, type Limits } from "./candidates";
import { DecideFailure } from "./jev";
import {
  decisionState,
  noPrevious,
  type Detection,
  type PreviousStep,
} from "./state";
import type { Decider } from "./strategies";
import type { ResolvedTask, TaskTracker } from "./tasks";

export interface LoopDeps {
  readonly observe: (signal: AbortSignal) => Promise<Observation>;
  readonly execute: (request: ActionRequest) => Promise<ActionResult>;
  readonly decider: Decider;
  readonly log: (event: string, data: Record<string, unknown>) => void;
  readonly sleep: (ms: number) => Promise<void>;
  /** Text-only perception for this observation (pixel frame, never images). */
  readonly perceive?: (
    obs: Observation,
    signal: AbortSignal
  ) => Promise<readonly Detection[]>;
  /** Observed by mock deciders that need the offered set. */
  readonly onOffered?: (offered: readonly Action[]) => void;
}

export interface LoopOptions {
  readonly runId: string;
  readonly mode: "dry-run" | "execute";
  readonly task: ResolvedTask;
  /** Decides goals, phases and completion from each observation. */
  readonly tracker: TaskTracker;
  readonly limits: Limits;
  readonly maxSteps: number;
  readonly maxSeconds: number;
  readonly signal: AbortSignal;
  readonly dryRunPauseMs?: number;
}

export interface LoopSummary {
  readonly end_reason: string;
  readonly steps: number;
  readonly executed: number;
  readonly completed: number;
  readonly failed: number;
  readonly rejected: number;
  readonly decider_errors: number;
  readonly stages_reached: number;
  readonly task_complete: boolean;
  readonly cost_usd: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

const summarize = (obs: Observation) => ({
  seq: obs.seq,
  boot_id: obs.boot_id,
  age_ms: Math.round(obs.age_ms),
  cameras: Object.fromEntries(
    Object.entries(obs.cameras).map(([name, camera]) => [
      name,
      {
        age_ms: camera.age_ms === null ? null : Math.round(camera.age_ms),
        error: camera.error,
      },
    ])
  ),
  fault: obs.fault,
  operator: obs.operator?.owner ?? null,
  measured: obs.measured,
});

const reason = (signal: AbortSignal) =>
  signal.reason instanceof Error
    ? signal.reason.message
    : String(signal.reason ?? "cancelled");

/**
 * observe → perceive → decide → validate → execute (shared executor) →
 * observe the measured outcome → log. One decision and at most one motion are
 * outstanding. Dry-run never calls the executor. An unknown outcome ends the
 * run; the executor never replays it.
 */
export const runDecisionLoop = async (
  deps: LoopDeps,
  options: LoopOptions
): Promise<LoopSummary> => {
  const started = performance.now();
  const counts = {
    steps: 0,
    executed: 0,
    completed: 0,
    failed: 0,
    rejected: 0,
    decider_errors: 0,
  };
  let failures = 0;
  let deciderFailures = 0;
  let observeFailures = 0;
  let stagesReached = 0;
  let complete = false;
  let cost = 0;
  let endReason = "max_steps";
  let previous: PreviousStep = noPrevious;
  const elapsedS = () => (performance.now() - started) / 1000;
  const { task, limits, signal } = options;

  while (counts.steps < options.maxSteps) {
    if (signal.aborted) {
      endReason = `aborted: ${reason(signal)}`;
      break;
    }
    if (elapsedS() > options.maxSeconds) {
      endReason = "max_seconds";
      break;
    }
    const cycleStart = performance.now();
    counts.steps += 1;
    const step = counts.steps;
    const elapsedMs = () => Math.round(performance.now() - cycleStart);

    let basis: Observation;
    try {
      basis = await deps.observe(signal);
      observeFailures = 0;
    } catch (error) {
      observeFailures += 1;
      deps.log("observe_failed", {
        step,
        error: error instanceof Error ? error.message : String(error),
      });
      if (observeFailures >= 3 || signal.aborted) {
        endReason = signal.aborted
          ? `aborted: ${reason(signal)}`
          : "observation_unavailable";
        break;
      }
      await deps.sleep(200);
      continue;
    }

    const detections = deps.perceive ? await deps.perceive(basis, signal) : [];
    const view = options.tracker.advance(basis, detections);
    for (const transition of view.transitions) {
      deps.log("stage_reached", {
        step,
        ...transition,
        measured: basis.measured,
      });
    }
    stagesReached = view.reachedCount;
    complete = view.complete;
    if (view.failed) {
      deps.log("task_failed", { step, phase: view.phase, reason: view.failed });
      endReason = `task_failed: ${view.failed}`;
      break;
    }
    const offered = candidates(
      basis,
      { goal: view.goal, explore: view.explore },
      limits
    );
    deps.onOffered?.(offered);
    const state = decisionState({
      obs: basis,
      task,
      view,
      limits,
      previous,
      progress: {
        step,
        max_steps: options.maxSteps,
        executed: counts.executed,
        completed: counts.completed,
        consecutive_failures: failures,
      },
      detections,
    });
    const record = {
      step,
      mode: options.mode,
      stage: state.task.stage,
      phase: view.phase,
      metrics: view.metrics,
      observation: summarize(basis),
      freshness: state.freshness,
      remaining: state.task.remaining,
      reached: state.task.reached,
      detections,
      candidates: offered.map((action) => action.id),
    };

    let decision;
    try {
      decision = await deps.decider.decide({ state, offered, signal });
      deciderFailures = 0;
    } catch (error) {
      const failure =
        error instanceof DecideFailure
          ? error
          : new DecideFailure("provider", String(error));
      counts.decider_errors += 1;
      deciderFailures += 1;
      deps.log("decision_failed", {
        ...record,
        strategy: deps.decider.strategy,
        failure: failure.kind,
        error: failure.message,
        cycle_ms: elapsedMs(),
      });
      if (failure.fatal || failure.kind === "aborted" || deciderFailures >= 2) {
        endReason = `decider_${failure.kind}`;
        break;
      }
      previous = {
        action_id: null,
        verdict: `decider_${failure.kind}`,
        outcome: "no action",
        measured_change: null,
      };
      continue;
    }
    cost += decision.cost_usd;
    const logged = { ...record, decision };
    const action = offered.find(
      (candidate) => candidate.id === decision.action_id
    );
    if (!action) {
      counts.rejected += 1;
      deps.log("step", {
        ...logged,
        verdict: "refused: not an offered candidate",
        outcome: "no motion",
        cycle_ms: elapsedMs(),
      });
      previous = {
        action_id: decision.action_id,
        verdict: "refused: not offered",
        outcome: "no motion",
        measured_change: null,
      };
      continue;
    }

    if (action.kind === "stop" || action.kind === "done") {
      if (action.kind === "done" && !complete) {
        deps.log("step", {
          ...logged,
          verdict: "refused: task not complete",
          outcome: "no motion",
          cycle_ms: elapsedMs(),
        });
        previous = {
          action_id: action.id,
          verdict: "refused: task not complete",
          outcome: "no motion",
          measured_change: null,
        };
        continue;
      }
      deps.log("step", {
        ...logged,
        verdict: "accepted",
        outcome: action.kind,
        cycle_ms: elapsedMs(),
      });
      endReason = action.kind === "done" ? "done" : "decider_stop";
      break;
    }
    if (action.kind === "reobserve" || action.kind === "wait") {
      deps.log("step", {
        ...logged,
        verdict: "accepted",
        outcome: action.kind,
        cycle_ms: elapsedMs(),
      });
      previous = {
        action_id: action.id,
        verdict: "accepted",
        outcome: "no motion",
        measured_change: null,
      };
      await deps.sleep(action.kind === "wait" ? 500 : 50);
      continue;
    }

    if (action.kind !== "step") {
      continue;
    }
    let now: Observation;
    try {
      now = await deps.observe(signal);
    } catch (error) {
      deps.log("step", {
        ...logged,
        verdict: "refused: observation unavailable",
        error: error instanceof Error ? error.message : String(error),
        cycle_ms: elapsedMs(),
      });
      previous = {
        action_id: action.id,
        verdict: "refused: observation unavailable",
        outcome: "no motion",
        measured_change: null,
      };
      continue;
    }
    const verdict = validate(action, offered, basis, now, limits);
    if (!verdict.ok) {
      counts.rejected += 1;
      deps.log("step", {
        ...logged,
        verdict: `refused: ${verdict.reason}`,
        outcome: "no motion",
        cycle_ms: elapsedMs(),
      });
      previous = {
        action_id: action.id,
        verdict: `refused: ${verdict.reason}`,
        outcome: "no motion",
        measured_change: null,
      };
      continue;
    }
    const move = {
      joint: action.joint,
      target: action.target,
      duration_s: action.duration_s,
    };
    if (options.mode === "dry-run") {
      deps.log("step", {
        ...logged,
        verdict: "valid",
        outcome: "not executed (dry-run)",
        would_move: move,
        cycle_ms: elapsedMs(),
      });
      previous = {
        action_id: action.id,
        verdict: "valid",
        outcome: "not executed (dry-run)",
        measured_change: null,
      };
      await deps.sleep(options.dryRunPauseMs ?? 1000);
      continue;
    }

    let result: ActionResult;
    try {
      counts.executed += 1;
      result = await deps.execute({
        id: `decision:${options.runId}:${step}`,
        owner: `decision-${options.runId}`,
        input: {
          target: { [action.joint]: action.target },
          duration_s: action.duration_s,
        },
        signal,
        progress: (event: MotionProgress) => {
          deps.log("motion", {
            step,
            phase: event.phase,
            status: event.operation?.status ?? null,
            result: event.result?.status ?? null,
          });
        },
      });
    } catch (error) {
      // Refused before admission (busy, unsafe target, control busy): nothing moved.
      counts.executed -= 1;
      counts.rejected += 1;
      failures += 1;
      const message =
        error instanceof ToolFailure ? error.message : String(error);
      deps.log("step", {
        ...logged,
        verdict: "valid",
        move,
        outcome: "refused_by_executor",
        error: message,
        cycle_ms: elapsedMs(),
      });
      previous = {
        action_id: action.id,
        verdict: "valid",
        outcome: `refused by executor: ${message}`,
        measured_change: null,
      };
      if (signal.aborted) {
        endReason = `aborted: ${reason(signal)}`;
        break;
      }
      if (failures >= 2) {
        endReason = "repeated_failures";
        break;
      }
      continue;
    }

    let after: Observation | null = null;
    try {
      after = await deps.observe(signal);
    } catch {
      after = null;
    }
    const change = after
      ? Object.fromEntries(
          joints
            .map(
              (joint) =>
                [
                  joint,
                  round((after?.measured[joint] ?? 0) - now.measured[joint]),
                ] as const
            )
            .filter(
              ([joint, delta]) =>
                joint === action.joint || Math.abs(delta) > 0.5
            )
        )
      : null;
    const hook = options.tracker.onStep?.({
      action,
      status: result.status,
      before: now,
      after,
    }) ?? { expected: false, note: null };
    if (result.status === "completed") {
      counts.completed += 1;
      failures = 0;
    } else if (hook.expected) {
      failures = 0;
    } else if (result.status !== "unknown") {
      counts.failed += 1;
      failures += 1;
    }
    deps.log("step", {
      ...logged,
      verdict: "valid",
      move,
      task_note: hook.note,
      request_id: result.request_id,
      operation_id: result.operation?.id ?? null,
      outcome: result.status,
      code: result.code ?? null,
      message: result.message,
      residual: result.operation?.residual?.[action.joint] ?? null,
      measured_change: change,
      cycle_ms: elapsedMs(),
    });
    previous = {
      action_id: action.id,
      verdict: "valid",
      outcome:
        result.status === "completed"
          ? "completed"
          : `${result.status}: ${result.message}`,
      measured_change: change,
    };
    if (result.status === "unknown") {
      endReason = "unknown_outcome";
      break;
    }
    if (signal.aborted) {
      endReason = `aborted: ${reason(signal)}`;
      break;
    }
    if (failures >= 2) {
      endReason = "repeated_failures";
      break;
    }
  }
  return {
    end_reason: endReason,
    ...counts,
    stages_reached: stagesReached,
    task_complete: complete,
    cost_usd: cost,
  };
};
