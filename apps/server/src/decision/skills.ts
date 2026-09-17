import { joints } from "@robo/domain";
import type { Joint, Observation } from "@robo/domain";

import { position, reach, tipFrame, type Vec3 } from "./kinematics";

/**
 * Skill controllers: bounded closed loops in code (the jev-drone "guidance"
 * layer). A tactician only chooses which skill runs next; every motion here is
 * a small joint move submitted through the shared executor, and the motor
 * owner still validates limits and table clearance.
 */
export const skillNames = [
  "scan_for_piece",
  "center_on_piece",
  "open_gripper",
  "descend",
  "close_gripper",
  "lift",
  "back_off",
  "hold",
] as const;
export type SkillName = (typeof skillNames)[number];

export interface WristView {
  readonly visible: boolean;
  readonly x: number | null;
  readonly y: number | null;
  readonly size: number;
  readonly background: boolean;
}

type MoveStatus = "completed" | "failed" | "cancelled" | "unknown" | "refused";

export interface MoveOutcome {
  readonly status: MoveStatus;
  readonly after: Observation | null;
  readonly message: string;
}

export interface SkillConfig {
  /** Where the piece appears in the wrist image when it sits between the jaws. */
  readonly graspPoint: { readonly x: number; readonly y: number };
  readonly centerTolerance: number;
  /** Model gripper-frame z when the jaw tips touch the mat. */
  readonly matZ: number;
  /** Tip height above the mat at which the gripper closes. */
  readonly graspHeightM: number;
  /** Minimum tip height for sweeping. */
  readonly scanHeightM: number;
  readonly liftM: number;
  readonly openPercent: number;
  readonly heldPercent: number;
  readonly scanPanOffsets: readonly number[];
  readonly limits: Readonly<Record<string, readonly [number, number]>>;
  /** Per-move joint cap, below the motor owner's max_step. */
  readonly moveCapDeg: number;
}

export const skillDefaults = {
  graspPoint: { x: -0.16, y: 0.09 },
  centerTolerance: 0.06,
  matZ: -0.044,
  graspHeightM: 0.012,
  scanHeightM: 0.05,
  liftM: 0.05,
  openPercent: 60,
  heldPercent: 4,
  scanPanOffsets: [12, -12, 24, -24, 36, -36, 48, -48, 60, -60],
  moveCapDeg: 1.6,
} as const;

/** What skills learn and remember across the run. */
export interface SkillMemory {
  /** Image offset per metre of tip motion in base x/y, measured at `jacobianHeightM`. */
  jacobian:
    | readonly [readonly [number, number], readonly [number, number]]
    | null;
  jacobianHeightM: number | null;
  contact: boolean;
  lastSeen: WristView | null;
  movesUsed: number;
}

export const newMemory = (): SkillMemory => ({
  jacobian: null,
  jacobianHeightM: null,
  contact: false,
  lastSeen: null,
  movesUsed: 0,
});

export interface SkillContext {
  readonly observe: () => Promise<Observation>;
  readonly look: (obs: Observation) => Promise<WristView>;
  readonly move: (
    target: Partial<Record<Joint, number>>,
    durationS: number
  ) => Promise<MoveOutcome>;
  readonly config: SkillConfig;
  readonly memory: SkillMemory;
  readonly maxMoves: number;
  readonly signal: AbortSignal;
}

type SkillResultKind = "done" | "stalled" | "vetoed" | "lost" | "failed";

export interface SkillResult {
  readonly skill: SkillName;
  readonly result: SkillResultKind;
  readonly detail: string;
  readonly moves: number;
  readonly imageMoved: number | null;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export const heightAboveMat = (obs: Observation, config: SkillConfig) =>
  (obs.ee[2] ?? 0) - config.matZ;

export const offsetOf = (view: WristView | null, config: SkillConfig) =>
  view?.visible && view.x !== null && view.y !== null
    ? { dx: view.x - config.graspPoint.x, dy: view.y - config.graspPoint.y }
    : null;

export const centered = (
  view: WristView | null,
  config: SkillConfig,
  factor = 1
) => {
  const offset = offsetOf(view, config);
  return (
    offset !== null &&
    Math.abs(offset.dx) <= config.centerTolerance * factor &&
    Math.abs(offset.dy) <= config.centerTolerance * factor
  );
};

class MoveBudget extends Error {
  constructor() {
    super("move budget used");
    this.name = "MoveBudget";
  }
}

/** Ended by an unknown motion outcome or cancellation: the run must stop. */
export class SkillAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillAbort";
  }
}

interface StepToward {
  readonly obs: Observation;
  readonly reached: boolean;
  readonly progressed: boolean;
  readonly outcome: MoveOutcome | null;
}

/** One capped move from the measured pose toward `goal` (all joints scaled together). */
const stepToward = async (
  ctx: SkillContext,
  obs: Observation,
  goal: Partial<Record<Joint, number>>,
  toleranceDeg = 0.9
): Promise<StepToward> => {
  const deltas = joints
    .filter((joint) => goal[joint] !== undefined)
    .map((joint) => [joint, (goal[joint] ?? 0) - obs.measured[joint]] as const);
  const largest = Math.max(0, ...deltas.map(([, delta]) => Math.abs(delta)));
  if (largest <= toleranceDeg) {
    return { obs, reached: true, progressed: false, outcome: null };
  }
  if (ctx.memory.movesUsed >= ctx.maxMoves) throw new MoveBudget();
  const scale = Math.min(1, ctx.config.moveCapDeg / largest);
  const target: Partial<Record<Joint, number>> = {};
  for (const [joint, delta] of deltas) {
    const [low, high] = ctx.config.limits[joint] ?? [-180, 180];
    target[joint] = round(
      Math.min(high, Math.max(low, obs.measured[joint] + delta * scale))
    );
  }
  ctx.memory.movesUsed += 1;
  const outcome = await ctx.move(
    target,
    round(Math.max(1, (largest * scale) / 1.8))
  );
  if (
    outcome.status === "unknown" ||
    outcome.status === "cancelled" ||
    ctx.signal.aborted
  ) {
    throw new SkillAbort(`move ${outcome.status}: ${outcome.message}`);
  }
  const after = outcome.after ?? (await ctx.observe());
  const moved = Math.max(
    0,
    ...deltas.map(([joint]) =>
      Math.abs(after.measured[joint] - obs.measured[joint])
    )
  );
  return { obs: after, reached: false, progressed: moved >= 0.4, outcome };
};

/** Drive toward a joint goal with capped moves until reached, stalled, or out of moves. */
const goToward = async (
  ctx: SkillContext,
  goal: Partial<Record<Joint, number>>,
  maxMoves: number,
  toleranceDeg = 0.9
) => {
  let obs = await ctx.observe();
  let stalls = 0;
  for (let i = 0; i < maxMoves; i += 1) {
    const step = await stepToward(ctx, obs, goal, toleranceDeg);
    obs = step.obs;
    if (step.reached) return { obs, reached: true, moves: i };
    stalls = step.progressed ? 0 : stalls + 1;
    if (stalls >= 3) return { obs, reached: false, moves: i + 1 };
  }
  return { obs, reached: false, moves: maxMoves };
};

/** Move the tip by a Cartesian displacement keeping the gripper pointing down. */
const moveTip = async (
  ctx: SkillContext,
  displacement: Vec3,
  maxMoves = 12
) => {
  const obs = await ctx.observe();
  const [x, y, z] = position(tipFrame(obs.measured));
  const target: Vec3 = [
    x + displacement[0],
    y + displacement[1],
    z + displacement[2],
  ];
  if (target[2] - ctx.config.matZ < 0.004) {
    return {
      obs,
      reached: false,
      moves: 0,
      vetoed: "target below mat clearance",
    };
  }
  const solution = reach(obs.measured, target, ctx.config.limits);
  if (solution.errorM > 0.006 || solution.downness < 0.95) {
    return {
      obs,
      reached: false,
      moves: 0,
      vetoed: `unreachable (error ${round(solution.errorM)} m, downness ${round(solution.downness)})`,
    };
  }
  const goal: Partial<Record<Joint, number>> = {
    shoulder_pan: solution.pose.shoulder_pan,
    shoulder_lift: solution.pose.shoulder_lift,
    elbow_flex: solution.pose.elbow_flex,
    wrist_flex: solution.pose.wrist_flex,
  };
  return { ...(await goToward(ctx, goal, maxMoves)), vetoed: null };
};

const result = (
  skill: SkillName,
  kind: SkillResultKind,
  detail: string,
  moves: number,
  imageMoved: number | null = null
): SkillResult => ({ skill, result: kind, detail, moves, imageMoved });

const runScan = async (ctx: SkillContext): Promise<SkillResult> => {
  let obs = await ctx.observe();
  if (heightAboveMat(obs, ctx.config) < ctx.config.scanHeightM) {
    return result(
      "scan_for_piece",
      "vetoed",
      "tip too low to sweep; lift first",
      0
    );
  }
  const startMoves = ctx.memory.movesUsed;
  let seen = 0;
  const check = async () => {
    const view = await ctx.look(obs);
    ctx.memory.lastSeen = view;
    seen = view.visible ? seen + 1 : 0;
    return seen >= 2 || (view.visible && centered(view, ctx.config, 3));
  };
  if (await check())
    return result("scan_for_piece", "done", "piece already in view", 0);
  const startPan = obs.measured.shoulder_pan;
  for (const offset of ctx.config.scanPanOffsets) {
    const [low, high] = ctx.config.limits["shoulder_pan"] ?? [-110, 110];
    const goalPan = Math.min(high - 2, Math.max(low + 2, startPan + offset));
    for (let i = 0; i < 40; i += 1) {
      const step = await stepToward(ctx, obs, { shoulder_pan: goalPan });
      obs = step.obs;
      if (await check()) {
        return result(
          "scan_for_piece",
          "done",
          `piece seen at pan ${round(obs.measured.shoulder_pan)}`,
          ctx.memory.movesUsed - startMoves
        );
      }
      if (step.reached) break;
    }
  }
  return result(
    "scan_for_piece",
    "lost",
    "swept the pan range without seeing the piece",
    ctx.memory.movesUsed - startMoves
  );
};

const runCenter = async (ctx: SkillContext): Promise<SkillResult> => {
  const startMoves = ctx.memory.movesUsed;
  let obs = await ctx.observe();
  let view = await ctx.look(obs);
  if (!view.visible)
    return result("center_on_piece", "lost", "piece not visible", 0);
  const firstOffset = offsetOf(view, ctx.config);
  const height = heightAboveMat(obs, ctx.config);
  const stale =
    ctx.memory.jacobian === null ||
    ctx.memory.jacobianHeightM === null ||
    Math.abs(ctx.memory.jacobianHeightM - height) / Math.max(0.01, height) >
      0.3;
  if (stale) {
    const columns: [number, number][] = [];
    for (const axis of [0, 1] as const) {
      const before = offsetOf(view, ctx.config);
      const beforeTip = position(tipFrame(obs.measured));
      const probe: Vec3 = axis === 0 ? [0.01, 0, 0] : [0, 0.01, 0];
      const moved = await moveTip(ctx, probe, 6);
      if (moved.vetoed)
        return result(
          "center_on_piece",
          "vetoed",
          `probe ${moved.vetoed}`,
          ctx.memory.movesUsed - startMoves
        );
      obs = moved.obs;
      view = await ctx.look(obs);
      const after = offsetOf(view, ctx.config);
      if (!before || !after)
        return result(
          "center_on_piece",
          "lost",
          "piece left the view while probing",
          ctx.memory.movesUsed - startMoves
        );
      const afterTip = position(tipFrame(obs.measured));
      const travelled = afterTip[axis] - beforeTip[axis];
      if (Math.abs(travelled) < 0.004)
        return result(
          "center_on_piece",
          "stalled",
          "probe move did not travel",
          ctx.memory.movesUsed - startMoves
        );
      columns.push([
        (after.dx - before.dx) / travelled,
        (after.dy - before.dy) / travelled,
      ]);
    }
    const [cx, cy] = columns;
    if (!cx || !cy)
      return result(
        "center_on_piece",
        "failed",
        "probe incomplete",
        ctx.memory.movesUsed - startMoves
      );
    ctx.memory.jacobian = [
      [cx[0], cy[0]],
      [cx[1], cy[1]],
    ];
    ctx.memory.jacobianHeightM = heightAboveMat(obs, ctx.config);
  }
  for (let i = 0; i < 10; i += 1) {
    const offset = offsetOf(view, ctx.config);
    if (!offset)
      return result(
        "center_on_piece",
        "lost",
        "piece left the view",
        ctx.memory.movesUsed - startMoves
      );
    if (centered(view, ctx.config)) {
      const moved = firstOffset
        ? round(
            Math.hypot(offset.dx - firstOffset.dx, offset.dy - firstOffset.dy)
          )
        : null;
      return result(
        "center_on_piece",
        "done",
        "piece at the grasp point",
        ctx.memory.movesUsed - startMoves,
        moved
      );
    }
    const jac = ctx.memory.jacobian;
    if (!jac)
      return result(
        "center_on_piece",
        "failed",
        "no image model",
        ctx.memory.movesUsed - startMoves
      );
    const scale =
      (ctx.memory.jacobianHeightM ?? height) /
      Math.max(0.01, heightAboveMat(obs, ctx.config));
    const [[a, b], [c, d]] = [
      [jac[0][0] * scale, jac[0][1] * scale],
      [jac[1][0] * scale, jac[1][1] * scale],
    ];
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-6)
      return result(
        "center_on_piece",
        "stalled",
        "image model is singular",
        ctx.memory.movesUsed - startMoves
      );
    let mx = (-(d * offset.dx - b * offset.dy) / det) * 0.7;
    let my = (-(-c * offset.dx + a * offset.dy) / det) * 0.7;
    const norm = Math.hypot(mx, my);
    if (norm > 0.02) {
      mx = (mx / norm) * 0.02;
      my = (my / norm) * 0.02;
    }
    const moved = await moveTip(ctx, [mx, my, 0], 8);
    if (moved.vetoed)
      return result(
        "center_on_piece",
        "vetoed",
        moved.vetoed,
        ctx.memory.movesUsed - startMoves
      );
    obs = moved.obs;
    view = await ctx.look(obs);
    ctx.memory.lastSeen = view;
  }
  return result(
    "center_on_piece",
    "stalled",
    "not centred after 10 corrections",
    ctx.memory.movesUsed - startMoves
  );
};

const runDescend = async (ctx: SkillContext): Promise<SkillResult> => {
  const startMoves = ctx.memory.movesUsed;
  let obs = await ctx.observe();
  let view = await ctx.look(obs);
  if (!centered(view, ctx.config, 2)) {
    return result(
      "descend",
      "vetoed",
      "piece not centred; center_on_piece first",
      0
    );
  }
  for (let i = 0; i < 12; i += 1) {
    const height = heightAboveMat(obs, ctx.config);
    if (height <= ctx.config.graspHeightM + 0.003) {
      return result(
        "descend",
        "done",
        `tip ${round(height * 100)} cm above the mat`,
        ctx.memory.movesUsed - startMoves
      );
    }
    const dz = -Math.min(0.015, height - ctx.config.graspHeightM);
    const moved = await moveTip(ctx, [0, 0, dz], 8);
    if (moved.vetoed)
      return result(
        "descend",
        "vetoed",
        moved.vetoed,
        ctx.memory.movesUsed - startMoves
      );
    obs = moved.obs;
    view = await ctx.look(obs);
    ctx.memory.lastSeen = view;
    if (!moved.reached && heightAboveMat(obs, ctx.config) > height - 0.003) {
      return result(
        "descend",
        "stalled",
        "tip did not go lower",
        ctx.memory.movesUsed - startMoves
      );
    }
    if (view.visible && !centered(view, ctx.config, 2)) {
      return result(
        "descend",
        "stalled",
        "drifted off centre; re-centre",
        ctx.memory.movesUsed - startMoves
      );
    }
  }
  return result(
    "descend",
    "stalled",
    "descent incomplete",
    ctx.memory.movesUsed - startMoves
  );
};

const runClose = async (ctx: SkillContext): Promise<SkillResult> => {
  const startMoves = ctx.memory.movesUsed;
  let obs = await ctx.observe();
  const view = await ctx.look(obs);
  if (heightAboveMat(obs, ctx.config) > ctx.config.graspHeightM + 0.02) {
    return result(
      "close_gripper",
      "vetoed",
      "tip too high to grasp; descend first",
      0
    );
  }
  if (view.visible && !centered(view, ctx.config, 2)) {
    return result("close_gripper", "vetoed", "piece not between the jaws", 0);
  }
  for (let i = 0; i < 40; i += 1) {
    if (obs.measured.gripper <= ctx.config.heldPercent - 2) {
      ctx.memory.contact = false;
      return result(
        "close_gripper",
        "failed",
        "closed empty",
        ctx.memory.movesUsed - startMoves
      );
    }
    const target = Math.max(0, obs.measured.gripper - ctx.config.moveCapDeg);
    const step = await stepToward(ctx, obs, { gripper: target }, 0.1);
    obs = step.obs;
    if (
      obs.measured.gripper >= ctx.config.heldPercent &&
      obs.measured.gripper <= 35 &&
      obs.measured.gripper > target + 1.5
    ) {
      ctx.memory.contact = true;
      return result(
        "close_gripper",
        "done",
        `stalled on the piece at ${round(obs.measured.gripper)} %`,
        ctx.memory.movesUsed - startMoves
      );
    }
  }
  return result(
    "close_gripper",
    "stalled",
    "gripper did not finish closing",
    ctx.memory.movesUsed - startMoves
  );
};

const runLift = async (
  ctx: SkillContext,
  meters: number,
  skill: SkillName
): Promise<SkillResult> => {
  const startMoves = ctx.memory.movesUsed;
  const start = heightAboveMat(await ctx.observe(), ctx.config);
  let obs = await ctx.observe();
  for (let i = 0; i < 8; i += 1) {
    const height = heightAboveMat(obs, ctx.config);
    if (height >= start + meters - 0.005) {
      return result(
        skill,
        "done",
        `tip ${round(height * 100)} cm above the mat`,
        ctx.memory.movesUsed - startMoves
      );
    }
    const moved = await moveTip(
      ctx,
      [0, 0, Math.min(0.015, start + meters - height)],
      8
    );
    if (moved.vetoed)
      return result(
        skill,
        "vetoed",
        moved.vetoed,
        ctx.memory.movesUsed - startMoves
      );
    obs = moved.obs;
    if (!moved.reached && heightAboveMat(obs, ctx.config) < height + 0.003) {
      return result(
        skill,
        "stalled",
        "tip did not rise",
        ctx.memory.movesUsed - startMoves
      );
    }
  }
  return result(
    skill,
    "stalled",
    "lift incomplete",
    ctx.memory.movesUsed - startMoves
  );
};

export const runSkill = async (
  ctx: SkillContext,
  skill: SkillName
): Promise<SkillResult> => {
  try {
    switch (skill) {
      case "scan_for_piece": {
        return await runScan(ctx);
      }
      case "center_on_piece": {
        return await runCenter(ctx);
      }
      case "open_gripper": {
        const start = ctx.memory.movesUsed;
        const moved = await goToward(
          ctx,
          { gripper: ctx.config.openPercent },
          40,
          2
        );
        ctx.memory.contact = false;
        return result(
          skill,
          moved.reached ? "done" : "stalled",
          `gripper ${round(moved.obs.measured.gripper)} %`,
          ctx.memory.movesUsed - start
        );
      }
      case "descend": {
        return await runDescend(ctx);
      }
      case "close_gripper": {
        return await runClose(ctx);
      }
      case "lift": {
        return await runLift(ctx, ctx.config.liftM, skill);
      }
      case "back_off": {
        const lifted = await runLift(ctx, 0.03, skill);
        const start = ctx.memory.movesUsed;
        const opened = await goToward(
          ctx,
          { gripper: ctx.config.openPercent },
          40,
          2
        );
        ctx.memory.contact = false;
        return result(
          skill,
          lifted.result === "done" && opened.reached ? "done" : "stalled",
          `${lifted.detail}; gripper ${round(opened.obs.measured.gripper)} %`,
          lifted.moves + ctx.memory.movesUsed - start
        );
      }
      case "hold": {
        return result(skill, "done", "held position", 0);
      }
    }
  } catch (error) {
    if (error instanceof MoveBudget)
      return result(skill, "failed", "run move budget used", 0);
    throw error;
  }
};
