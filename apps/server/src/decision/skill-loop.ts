import type { Observation } from "@robo/domain";

import { DecideFailure } from "./jev";
import { buildScene, fingerprint, type SceneState } from "./scene-state";
import {
  newMemory,
  runSkill,
  SkillAbort,
  heightAboveMat,
  type SkillConfig,
  type SkillContext,
  type SkillResult,
} from "./skills";
import { THRESHOLDS, type Judgment, type Tactician } from "./tactics";

export interface SkillLoopDeps {
  readonly observe: SkillContext["observe"];
  readonly look: SkillContext["look"];
  readonly move: SkillContext["move"];
  readonly tactician: Tactician;
  readonly log: (event: string, data: Record<string, unknown>) => void;
}

export interface SkillLoopOptions {
  readonly mode: "dry-run" | "execute";
  readonly config: SkillConfig;
  readonly maxMoves: number;
  readonly maxSeconds: number;
  readonly maxJudgments: number;
  readonly signal: AbortSignal;
}

export interface SkillLoopSummary {
  readonly end_reason: string;
  readonly task_complete: boolean;
  readonly skills_run: number;
  readonly judgments: number;
  readonly cached_judgments: number;
  readonly moves: number;
  readonly cost_usd: number;
}

const brief = (scene: SceneState) => ({
  piece: scene.observed.piece,
  gripper: scene.observed.gripper,
  tip: scene.observed.tip,
  last_skill: scene.observed.last_skill,
});

/**
 * Tactician chooses a skill → code vetoes or runs it → observe → repeat.
 * Judgments are reused while the scene fingerprint is unchanged.
 */
export const runSkillLoop = async (
  deps: SkillLoopDeps,
  options: SkillLoopOptions
): Promise<SkillLoopSummary> => {
  const started = performance.now();
  const memory = newMemory();
  const counts = { skills: 0, judgments: 0, cached: 0, cost: 0 };
  let last: SkillResult | null = null;
  let repeats = 0;
  let unseen = 0;
  let noProgress = 0;
  let graspHeightAt: number | null = null;
  let cachedKey: string | null = null;
  let cached: Judgment | null = null;
  let endReason = "max_judgments";
  let complete = false;

  for (let turn = 0; turn < options.maxJudgments; turn += 1) {
    if (options.signal.aborted) {
      endReason = "aborted";
      break;
    }
    if ((performance.now() - started) / 1000 > options.maxSeconds) {
      endReason = "max_seconds";
      break;
    }
    const obs: Observation = await deps.observe();
    if (obs.fault) {
      endReason = `fault: ${obs.fault}`;
      break;
    }
    const view = await deps.look(obs);
    unseen = view.visible ? 0 : unseen + 1;
    const scene = buildScene({
      obs,
      view,
      config: options.config,
      memory,
      last,
      repeats,
      unseenSteps: unseen,
      skillsRun: counts.skills,
      maxMoves: options.maxMoves,
      graspHeightReachedAtM: graspHeightAt,
    });
    const key = fingerprint(scene);
    let judgment: Judgment;
    if (cached && key === cachedKey) {
      judgment = cached;
      counts.cached += 1;
    } else {
      try {
        judgment = await deps.tactician.judge(scene, options.signal);
      } catch (error) {
        const failure =
          error instanceof DecideFailure
            ? error
            : new DecideFailure("provider", String(error));
        deps.log("tactics_failed", {
          turn,
          failure: failure.kind,
          error: failure.message,
        });
        endReason = `tactician_${failure.kind}`;
        break;
      }
      counts.judgments += 1;
      counts.cost += judgment.costUsd;
      cached = judgment;
      cachedKey = key;
    }
    let chosen = judgment.next;
    let veto: string | null = null;
    if (chosen === "done" && !scene.observed.tip.lifted_with_piece) {
      veto = "done refused: the piece is not held and lifted";
      chosen = "hold";
    } else if (
      judgment.risk !== null &&
      judgment.risk >= THRESHOLDS.backOffRisk &&
      !scene.observed.gripper.holding &&
      chosen !== "back_off" &&
      heightAboveMat(obs, options.config) < 0.04
    ) {
      veto = `risk ${judgment.risk} ≥ ${THRESHOLDS.backOffRisk}: backing off`;
      chosen = "back_off";
    }
    deps.log("tactics", {
      turn,
      scene: brief(scene),
      next: judgment.next,
      chosen,
      veto,
      probabilities: judgment.probabilities,
      grasp_ready: judgment.graspReady,
      risk: judgment.risk,
      piece_held: judgment.pieceHeld,
      source: judgment.source,
      cached: judgment === cached && counts.cached > 0 && key === cachedKey,
      latency_ms: judgment.latencyMs,
      cost_usd: judgment.costUsd,
    });
    if (chosen === "done") {
      endReason = "done";
      complete = true;
      break;
    }
    if (chosen === "stop") {
      endReason = "tactician_stop";
      break;
    }
    if (options.mode === "dry-run") {
      // Nothing moves, so the scene would not change: one judgment is the preview.
      endReason = "dry-run";
      break;
    }
    deps.log("skill_started", { turn, skill: chosen });
    let outcome: SkillResult;
    try {
      outcome = await runSkill(
        {
          observe: deps.observe,
          look: deps.look,
          move: deps.move,
          config: options.config,
          memory,
          maxMoves: options.maxMoves,
          signal: options.signal,
        },
        chosen
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log("skill_aborted", { turn, skill: chosen, error: message });
      endReason =
        error instanceof SkillAbort
          ? `skill_aborted: ${message}`
          : `skill_error: ${message}`;
      break;
    }
    counts.skills += 1;
    repeats =
      last && last.skill === outcome.skill && last.result === outcome.result
        ? repeats + 1
        : 0;
    last =
      veto && chosen === "hold"
        ? { ...outcome, result: "vetoed", detail: veto }
        : outcome;
    if (outcome.skill === "close_gripper" && outcome.result === "done") {
      graspHeightAt = heightAboveMat(await deps.observe(), options.config);
    }
    noProgress =
      outcome.result === "done" && outcome.skill !== "hold"
        ? 0
        : noProgress + 1;
    deps.log("skill_finished", {
      turn,
      ...outcome,
      moves_used: memory.movesUsed,
    });
    if (memory.movesUsed >= options.maxMoves) {
      endReason = "move_budget";
      break;
    }
    if (noProgress >= THRESHOLDS.maxNoProgress) {
      endReason = "no_progress";
      break;
    }
  }
  return {
    end_reason: endReason,
    task_complete: complete,
    skills_run: counts.skills,
    judgments: counts.judgments,
    cached_judgments: counts.cached,
    moves: memory.movesUsed,
    cost_usd: counts.cost,
  };
};
