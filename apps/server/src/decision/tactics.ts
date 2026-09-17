import {
  booleanAnswer,
  choiceAnswer,
  scoreAnswer,
  type Evaluator,
} from "./jev";
import type { SceneState } from "./scene-state";
import type { SkillName } from "./skills";

/**
 * The tactical layer: everything the decision model is asked lives in this
 * file (questions, option rubrics, thresholds), after jev-drone's tactics.py.
 * Code decides when to ask, reuses answers for unchanged scenes, and keeps the
 * veto; the answers only choose which bounded skill runs next.
 */
export type TacticChoice = SkillName | "done" | "stop";

export const THRESHOLDS = {
  /** risk score (0 clear .. 2 about to collide) above which code backs off instead. */
  backOffRisk: 1.5,
  /** consecutive skills without a "done" result before the run gives up. */
  maxNoProgress: 6,
} as const;

const role =
  "You are the tactical decision layer of a small robot arm picking up an object.";

const NEXT_SKILL_OPTIONS: Readonly<Record<TacticChoice, string>> = {
  scan_for_piece:
    "observed.piece.visible_wrist is false (the wrist camera cannot see the piece) and observed.tip.high_enough_to_sweep is true. Search for the piece: the skill rises to a vantage height by itself and sweeps arcs of the mat at increasing distance from the base. Not useful when the piece is already visible.",
  center_on_piece:
    "The piece is visible (observed.piece.visible_wrist true) but observed.piece.centered is false: offset_x or offset_y is larger than about 0.06. Move the gripper so the piece sits at the grasp point. Also right after descend reports it drifted off centre.",
  open_gripper:
    "The piece is centred but observed.gripper.open_enough is false, or a grasp failed and the jaws must reopen before trying again. Open the jaws wide.",
  descend:
    "The piece is centred, observed.gripper.open_enough is true and observed.tip.at_grasp_height is false: lower the open gripper straight down around the piece.",
  close_gripper:
    "observed.tip.at_grasp_height is true, the piece is centred or no longer visible because it is between the jaws, and observed.gripper.stalled_on_object is false: close the jaws on the piece.",
  lift: "observed.gripper.stalled_on_object and observed.gripper.holding are true but observed.tip.lifted_with_piece is false: raise the piece off the mat.",
  back_off:
    "Something went wrong close to the mat: a close failed (last_skill.result failed with detail 'closed empty'), or the same skill keeps stalling (last_skill.repeats 2 or more) while the tip is low. Rise a few centimetres and reopen to try again.",
  hold: "Nothing useful can be done this moment, for example the last skill just changed the scene and a fresh look is needed.",
  done: "observed.tip.lifted_with_piece is true: the piece is held and raised. The task is complete.",
  stop: "The task cannot be completed: observed.progress.moves_left is nearly 0, scanning has failed repeatedly (last_skill scan_for_piece with result lost and repeats 1 or more), or a joint in observed.joint_health has follows false while the last skill stalled or failed -- the arm cannot make the moves being asked of it and retrying will not change that.",
};

const QUESTIONS = {
  next_skill: {
    type: "choice" as const,
    instructions: {
      role,
      mission:
        "Use observed.* to pick the single skill to run next. Follow the order of the task: find, centre, open, descend, close, lift.",
      ask: "Which skill should run next?",
    },
    criteria: NEXT_SKILL_OPTIONS,
  },
  grasp_ready: {
    type: "boolean" as const,
    instructions:
      "Would closing the gripper now capture the piece? It needs the tip at grasp height, the jaws open, and the piece centred between them.",
    criteria: {
      true: "Close now.",
      false: "Closing now would miss or only push the piece.",
    },
  },
  risk: {
    type: "score" as const,
    instructions:
      "How risky is the arm's immediate situation for the piece and the arm? Consider tip height, repeated stalls and failures.",
    criteria: [
      "clear: high above the mat or progressing normally",
      "tight: low above the mat, or a skill stalled once",
      "about to go wrong: low with repeated stalls or failed grasps",
    ],
  },
  piece_held: {
    type: "boolean" as const,
    instructions:
      "Is the piece actually held in the gripper? Judge from observed.gripper.stalled_on_object, observed.gripper.holding and whether the piece is still seen between the jaws.",
  },
};

export interface Judgment {
  readonly next: TacticChoice;
  readonly probabilities: Readonly<Record<string, number>> | null;
  readonly graspReady: number | null;
  readonly risk: number | null;
  readonly pieceHeld: number | null;
  readonly source: string;
  readonly latencyMs: number;
  readonly costUsd: number;
}

export interface Tactician {
  readonly name: string;
  readonly judge: (scene: SceneState, signal: AbortSignal) => Promise<Judgment>;
}

const choices = Object.keys(NEXT_SKILL_OPTIONS) as TacticChoice[];

export const jevTactician = (evaluate: Evaluator): Tactician => ({
  name: "jev/tactics-v1",
  judge: async (scene, signal) => {
    const outcome = await evaluate({
      state: scene,
      questions: QUESTIONS,
      signal,
    });
    const next = choiceAnswer(outcome.answers["next_skill"], choices);
    return {
      next: next.choice as TacticChoice,
      probabilities: next.probabilities,
      graspReady: booleanAnswer(outcome.answers["grasp_ready"]),
      risk: scoreAnswer(
        outcome.answers["risk"],
        QUESTIONS.risk.criteria.length
      ),
      pieceHeld: booleanAnswer(outcome.answers["piece_held"]),
      source: outcome.model,
      latencyMs: outcome.latency_ms,
      costUsd: outcome.cost_usd,
    };
  },
});

/** The same decision as a plain rule tree over the same scene. */
export const rulesNext = (scene: SceneState): TacticChoice => {
  const { piece, gripper, tip, last_skill: last, progress } = scene.observed;
  if (tip.lifted_with_piece) return "done";
  if (progress.moves_left < 5) return "stop";
  // A joint that no longer follows its commands is why the last skill
  // stalled; asking again would spend the move budget on the same stall.
  const stalledJoint = Object.values(scene.observed.joint_health).some(
    (health) => !health.follows
  );
  if (stalledJoint && (last.result === "stalled" || last.result === "failed"))
    return "stop";
  if (gripper.holding) return "lift";
  if (last.result === "failed" && last.detail === "closed empty")
    return "back_off";
  if (
    tip.at_grasp_height &&
    (piece.centered || !piece.visible_wrist) &&
    gripper.open_enough
  )
    return "close_gripper";
  if (!piece.visible_wrist) {
    if (!tip.high_enough_to_sweep) return "back_off";
    return last.name === "scan_for_piece" &&
      last.result === "lost" &&
      last.repeats >= 1
      ? "stop"
      : "scan_for_piece";
  }
  if (!piece.centered)
    return last.name === "center_on_piece" && last.repeats >= 3
      ? "back_off"
      : "center_on_piece";
  if (!gripper.open_enough) return "open_gripper";
  return "descend";
};

export const rulesTactician = (): Tactician => ({
  name: "rules/tactics-v1",
  judge: (scene) =>
    Promise.resolve({
      next: rulesNext(scene),
      probabilities: null,
      graspReady: null,
      risk: null,
      pieceHeld: null,
      source: "rules",
      latencyMs: 0,
      costUsd: 0,
    }),
});
