import type { Observation } from "@robo/domain";

import { downness, tipFrame } from "./kinematics";
import {
  centered,
  heightAboveMat,
  offsetOf,
  skillNames,
  type SkillConfig,
  type SkillMemory,
  type SkillResult,
  type WristView,
} from "./skills";

/**
 * The tactician's whole world, jev-drone style: mission, robot capabilities,
 * and what is observed now. Everything a rubric refers to must be here, and
 * nothing the robot cannot observe.
 */
const MISSION =
  "Pick up the small white piece standing on the black mat and lift it about 5 cm. Touching the mat lightly is acceptable; knocking the piece over or pushing it away is not.";

const ROBOT = {
  type: "SO-101 5-joint arm with a parallel gripper; slow, bounded moves of under 2 degrees per joint per step",
  wrist_camera:
    "mounted by the jaws, looking along them toward the mat; piece offsets are measured from the point where a piece sits between the jaws",
  gripper_max_opening_pct: 100,
  piece_needs_opening_pct: 45,
  piece_height_cm: 2.5,
  grasp_height_cm:
    "close the gripper when the tip is about 1-2 cm above the mat",
  skills: skillNames,
} as const;

export interface SceneState {
  readonly mission: string;
  readonly robot: typeof ROBOT;
  readonly observed: {
    readonly piece: {
      readonly visible_wrist: boolean;
      readonly offset_x: number | null;
      readonly offset_y: number | null;
      readonly centered: boolean;
      readonly size_frac: number | null;
      readonly unseen_for_steps: number;
    };
    readonly gripper: {
      readonly opening_pct: number;
      readonly open_enough: boolean;
      readonly stalled_on_object: boolean;
      readonly holding: boolean;
    };
    readonly tip: {
      readonly height_above_mat_cm: number;
      readonly at_grasp_height: boolean;
      readonly high_enough_to_sweep: boolean;
      readonly lifted_with_piece: boolean;
      readonly pointing_down: number;
    };
    readonly last_skill: {
      readonly name: string | null;
      readonly result: string | null;
      readonly detail: string | null;
      readonly repeats: number;
    };
    readonly progress: {
      readonly skills_run: number;
      readonly moves_used: number;
      readonly moves_left: number;
    };
  };
}

const round = (value: number, places = 3) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

export interface SceneInput {
  readonly obs: Observation;
  readonly view: WristView;
  readonly config: SkillConfig;
  readonly memory: SkillMemory;
  readonly last: SkillResult | null;
  readonly repeats: number;
  readonly unseenSteps: number;
  readonly skillsRun: number;
  readonly maxMoves: number;
  readonly graspHeightReachedAtM: number | null;
}

export const buildScene = (input: SceneInput): SceneState => {
  const { obs, view, config, memory } = input;
  const offset = offsetOf(view, config);
  const height = heightAboveMat(obs, config);
  const holding = memory.contact && obs.measured.gripper >= config.heldPercent;
  return {
    mission: MISSION,
    robot: ROBOT,
    observed: {
      piece: {
        visible_wrist: view.visible,
        offset_x: offset ? round(offset.dx) : null,
        offset_y: offset ? round(offset.dy) : null,
        centered: centered(view, config),
        size_frac: view.visible ? round(view.size) : null,
        unseen_for_steps: input.unseenSteps,
      },
      gripper: {
        opening_pct: round(obs.measured.gripper, 1),
        open_enough: obs.measured.gripper >= ROBOT.piece_needs_opening_pct,
        stalled_on_object: memory.contact,
        holding,
      },
      tip: {
        height_above_mat_cm: round(height * 100, 1),
        at_grasp_height: height <= config.graspHeightM + 0.006,
        high_enough_to_sweep: height >= config.scanHeightM,
        lifted_with_piece:
          holding &&
          input.graspHeightReachedAtM !== null &&
          height >= input.graspHeightReachedAtM + config.liftM - 0.01,
        pointing_down: round(downness(tipFrame(obs.measured)), 2),
      },
      last_skill: {
        name: input.last?.skill ?? null,
        result: input.last?.result ?? null,
        detail: input.last?.detail ?? null,
        repeats: input.repeats,
      },
      progress: {
        skills_run: input.skillsRun,
        moves_used: memory.movesUsed,
        moves_left: Math.max(0, input.maxMoves - memory.movesUsed),
      },
    },
  };
};

/** Coarse fingerprint: re-ask only when the situation is materially new. */
export const fingerprint = (scene: SceneState): string => {
  const { piece, gripper, tip, last_skill: last } = scene.observed;
  return JSON.stringify([
    piece.visible_wrist,
    piece.offset_x === null ? null : Math.round(piece.offset_x / 0.05),
    piece.offset_y === null ? null : Math.round(piece.offset_y / 0.05),
    Math.round(gripper.opening_pct / 10),
    gripper.stalled_on_object,
    gripper.holding,
    Math.round(tip.height_above_mat_cm),
    tip.lifted_with_piece,
    last.name,
    last.result,
    last.repeats,
  ]);
};
