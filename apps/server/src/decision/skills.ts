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
  /** Tip step the centring trial takes before judging the image. */
  readonly centerStepM: number;
  /** Model gripper-frame z when the jaw tips touch the mat. */
  readonly matZ: number;
  /** Tip height above the mat at which the gripper closes. */
  readonly graspHeightM: number;
  /** Tip height the search rises to before sweeping. */
  readonly scanHeightM: number;
  /** Tip clearance below which a sweep would drag across the mat. */
  readonly sweepClearanceM: number;
  readonly liftM: number;
  readonly openPercent: number;
  readonly heldPercent: number;
  /** Half-width of the pan sweep, in degrees either side of the start heading. */
  readonly scanPanSpanDeg: number;
  /** How much further out each successive sweep reaches. */
  readonly scanReachStepM: number;
  /** How many arcs the search sweeps before giving up. */
  readonly scanArcs: number;
  readonly limits: Readonly<Record<string, readonly [number, number]>>;
  /** Per-move joint cap, below the motor owner's max_step. */
  readonly moveCapDeg: number;
}

export const skillDefaults = {
  graspPoint: { x: -0.16, y: 0.09 },
  centerTolerance: 0.06,
  centerStepM: 0.012,
  matZ: -0.044,
  graspHeightM: 0.012,
  scanHeightM: 0.1,
  sweepClearanceM: 0.03,
  liftM: 0.05,
  openPercent: 60,
  heldPercent: 4,
  scanPanSpanDeg: 45,
  scanReachStepM: 0.07,
  scanArcs: 3,
  moveCapDeg: 1.6,
} as const;

/** What skills learn and remember across the run. */
export interface SkillMemory {
  /** The tip direction that last brought the piece closer in the image. */
  centerDirection: Vec3 | null;
  contact: boolean;
  lastSeen: WristView | null;
  movesUsed: number;
}

export const newMemory = (): SkillMemory => ({
  centerDirection: null,
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
  const startMoves = ctx.memory.movesUsed;
  let obs = await ctx.observe();
  let seen = 0;
  const check = async () => {
    const view = await ctx.look(obs);
    ctx.memory.lastSeen = view;
    seen = view.visible ? seen + 1 : 0;
    return seen >= 2 || (view.visible && centered(view, ctx.config, 3));
  };
  if (await check()) {
    return result("scan_for_piece", "done", "piece already in view", 0);
  }
  // The wrist camera sits above the fingertips and looks along them, so a
  // hover a few centimetres over the mat covers only about a hand's width of
  // it. Rise first: at the scan height one arc covers roughly 20 cm of mat.
  const climb = ctx.config.scanHeightM - heightAboveMat(obs, ctx.config);
  if (climb > 0.01) {
    const up = await moveTip(ctx, [0, 0, climb], 24);
    obs = up.obs;
    if (
      up.vetoed &&
      heightAboveMat(obs, ctx.config) < ctx.config.scanHeightM / 2
    ) {
      return result(
        "scan_for_piece",
        "vetoed",
        `cannot rise to sweep: ${up.vetoed}`,
        ctx.memory.movesUsed - startMoves
      );
    }
    if (await check()) {
      return result(
        "scan_for_piece",
        "done",
        "piece seen while rising",
        ctx.memory.movesUsed - startMoves
      );
    }
  }
  // A serpentine raster: sweep the pan arc, step the reach outward, sweep
  // back. Each arc is one continuous pan traversal, so the search costs a
  // sweep per arc rather than a return trip per look position.
  const startPan = obs.measured.shoulder_pan;
  const [low, high] = ctx.config.limits["shoulder_pan"] ?? [-110, 110];
  const arcPan = (sign: number) =>
    Math.min(
      high - 2,
      Math.max(low + 2, startPan + sign * ctx.config.scanPanSpanDeg)
    );
  let sign = obs.measured.shoulder_pan <= startPan ? 1 : -1;
  for (let arc = 0; arc < ctx.config.scanArcs; arc += 1) {
    if (arc > 0) {
      // Step outward along the current heading, so successive arcs cover
      // rings of mat at increasing distance from the base.
      const [x, y] = position(tipFrame(obs.measured));
      const radius = Math.hypot(x, y);
      const step = ctx.config.scanReachStepM;
      const out = await moveTip(
        ctx,
        radius < 0.01
          ? [step, 0, 0]
          : [(x / radius) * step, (y / radius) * step, 0],
        24
      );
      obs = out.obs;
      if (out.vetoed) {
        return result(
          "scan_for_piece",
          "lost",
          `swept ${arc} arcs; cannot reach further out: ${out.vetoed}`,
          ctx.memory.movesUsed - startMoves
        );
      }
      if (await check()) {
        return result(
          "scan_for_piece",
          "done",
          `piece seen stepping out on arc ${arc}`,
          ctx.memory.movesUsed - startMoves
        );
      }
    }
    const goalPan = arcPan(sign);
    for (let i = 0; i < 80; i += 1) {
      const step = await stepToward(ctx, obs, { shoulder_pan: goalPan });
      obs = step.obs;
      // Looking after every move overloads the Pi, and two moves pan about
      // 3 degrees -- far less than the camera's footprint.
      if ((i % 2 === 1 || step.reached) && (await check())) {
        return result(
          "scan_for_piece",
          "done",
          `piece seen at pan ${round(obs.measured.shoulder_pan)}`,
          ctx.memory.movesUsed - startMoves
        );
      }
      if (step.reached) break;
      if (ctx.memory.movesUsed >= ctx.maxMoves) {
        return result(
          "scan_for_piece",
          "stalled",
          "search move budget used",
          ctx.memory.movesUsed - startMoves
        );
      }
    }
    sign = -sign;
  }
  return result(
    "scan_for_piece",
    "lost",
    `swept ${ctx.config.scanArcs} arcs without seeing the piece`,
    ctx.memory.movesUsed - startMoves
  );
};

/**
 * Bring the piece to the grasp point by trial: take a small step, keep it when
 * the piece moved closer in the image, undo it when it did not. An estimated
 * image Jacobian was tried first and was the fragile part -- one wrong sign or
 * scale pushed the piece out of frame -- while a step that is judged by its own
 * measured result cannot do that. The last direction that worked is tried
 * first, so a straight approach still costs about one step per iteration.
 */
const runCenter = async (ctx: SkillContext): Promise<SkillResult> => {
  const startMoves = ctx.memory.movesUsed;
  let obs = await ctx.observe();
  let view = await ctx.look(obs);
  if (!view.visible) {
    return result("center_on_piece", "lost", "piece not visible", 0);
  }
  const firstOffset = offsetOf(view, ctx.config);
  const size = (offset: { dx: number; dy: number } | null) =>
    offset ? Math.hypot(offset.dx, offset.dy) : Number.POSITIVE_INFINITY;
  const directions: readonly Vec3[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
  ];
  let step = ctx.config.centerStepM;
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const offset = offsetOf(view, ctx.config);
    if (!offset) {
      return result(
        "center_on_piece",
        "lost",
        "piece left the view",
        ctx.memory.movesUsed - startMoves
      );
    }
    if (centered(view, ctx.config)) {
      return result(
        "center_on_piece",
        "done",
        "piece at the grasp point",
        ctx.memory.movesUsed - startMoves,
        firstOffset
          ? round(
              Math.hypot(offset.dx - firstOffset.dx, offset.dy - firstOffset.dy)
            )
          : null
      );
    }
    if (ctx.memory.movesUsed >= ctx.maxMoves) {
      return result(
        "center_on_piece",
        "stalled",
        "move budget used while centring",
        ctx.memory.movesUsed - startMoves
      );
    }
    const preferred = ctx.memory.centerDirection;
    const ordered = preferred
      ? [preferred, ...directions.filter((d) => d !== preferred)]
      : directions;
    let improved = false;
    for (const direction of ordered) {
      const displacement: Vec3 = [direction[0] * step, direction[1] * step, 0];
      const moved = await moveTip(ctx, displacement, 8);
      obs = moved.obs;
      if (moved.vetoed) continue;
      view = await ctx.look(obs);
      ctx.memory.lastSeen = view;
      const after = offsetOf(view, ctx.config);
      if (view.visible && size(after) < size(offset) - 0.005) {
        ctx.memory.centerDirection = direction;
        improved = true;
        break;
      }
      // Undo: this direction made the image worse, or lost the piece.
      const back = await moveTip(
        ctx,
        [-displacement[0], -displacement[1], 0],
        8
      );
      obs = back.obs;
      view = await ctx.look(obs);
      ctx.memory.lastSeen = view;
      if (!view.visible) {
        return result(
          "center_on_piece",
          "lost",
          "piece left the view and did not come back",
          ctx.memory.movesUsed - startMoves
        );
      }
      if (ctx.memory.centerDirection === direction) {
        ctx.memory.centerDirection = null;
      }
    }
    if (!improved) {
      step /= 2;
      if (step < ctx.config.centerStepM / 4) {
        return result(
          "center_on_piece",
          "stalled",
          `no step reduces the offset below ${round(size(offset))}`,
          ctx.memory.movesUsed - startMoves
        );
      }
    }
  }
  return result(
    "center_on_piece",
    "stalled",
    "not centred after 24 attempts",
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
