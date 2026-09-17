import { expect, test } from "bun:test";

import type { Joint, Observation } from "@robo/domain";

import { fixtureObservation } from "./fixtures";
import { memoryMeter } from "./jev";
import { position, tipFrame, type Vec3 } from "./kinematics";
import { mockTacticsEvaluator } from "./mock";
import { runSkillLoop } from "./skill-loop";
import {
  skillDefaults,
  type MoveOutcome,
  type SkillConfig,
  type WristView,
} from "./skills";
import { jevTactician, rulesTactician, type Tactician } from "./tactics";

const limits = {
  shoulder_pan: [-111.8, 111.8],
  shoulder_lift: [-111.3, 111.3],
  elbow_flex: [-98.4, 98.4],
  wrist_flex: [-103, 103],
  wrist_roll: [-180, 180],
  gripper: [0, 100],
} as const;

const config: SkillConfig = {
  ...skillDefaults,
  graspPoint: { x: 0, y: 0 },
  limits,
};

/**
 * Simulated arm: joints reach their targets, the tip follows the lab URDF, a
 * wrist camera 6 cm up the gripper looks along it, and the jaws stall on the
 * piece when they close around it.
 */
const simulate = (piece: Vec3, startPose: Record<Joint, number>) => {
  let measured = { ...startPose };
  let moves = 0;
  const tips: Vec3[] = [];
  const observe = (): Observation => {
    const m = tipFrame(measured);
    return fixtureObservation({
      backend: "mock",
      measured,
      commanded: measured,
      ee: position(m),
      limits,
    });
  };
  const look = async (obs: Observation): Promise<WristView> => {
    const m = tipFrame(obs.measured);
    const axis: Vec3 = [m[0]?.[2] ?? 0, m[1]?.[2] ?? 0, m[2]?.[2] ?? 0];
    const tip = position(m);
    const camera: Vec3 = [
      tip[0] - 0.06 * axis[0],
      tip[1] - 0.06 * axis[1],
      tip[2] - 0.06 * axis[2],
    ];
    const v: Vec3 = [
      piece[0] - camera[0],
      piece[1] - camera[1],
      piece[2] - camera[2],
    ];
    const local = [0, 1, 2].map(
      (c) =>
        (m[0]?.[c] ?? 0) * v[0] +
        (m[1]?.[c] ?? 0) * v[1] +
        (m[2]?.[c] ?? 0) * v[2]
    );
    const [lx = 0, ly = 0, lz = 0] = local;
    if (lz <= 0.01)
      return { visible: false, x: null, y: null, size: 0, background: false };
    const x = (lx / lz) * 0.8;
    const y = (ly / lz) * 0.8;
    const visible = Math.abs(x) <= 1 && Math.abs(y) <= 1;
    return {
      visible,
      x: visible ? x : null,
      y: visible ? y : null,
      size: 0.02 / lz,
      background: false,
    };
  };
  const move = async (
    target: Partial<Record<Joint, number>>
  ): Promise<MoveOutcome> => {
    moves += 1;
    const next = { ...measured, ...target };
    const tip = position(tipFrame(next));
    const around =
      Math.hypot(tip[0] - piece[0], tip[1] - piece[1]) <= 0.012 &&
      tip[2] - config.matZ <= config.graspHeightM + 0.012;
    if (
      target.gripper !== undefined &&
      target.gripper < 12 &&
      measured.gripper >= 12 &&
      around
    ) {
      measured = { ...next, gripper: 12 };
      return {
        status: "failed",
        after: observe(),
        message: "Target did not settle before deadline",
      };
    }
    measured = next;
    tips.push(tip);
    return { status: "completed", after: observe(), message: "ok" };
  };
  return {
    observe: async () => observe(),
    look,
    move,
    moves: () => moves,
    measured: () => measured,
    tips: () => tips,
  };
};

const hover = {
  shoulder_pan: 1.1,
  shoulder_lift: -0.2,
  elbow_flex: 29.1,
  wrist_flex: 69.5,
  wrist_roll: -8.9,
  gripper: 20,
};
const matPiece = (x: number, y: number): Vec3 => [x, y, config.matZ + 0.0125];

const runWith = async (tactician: Tactician, piece: Vec3) => {
  const sim = simulate(piece, hover);
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const summary = await runSkillLoop(
    {
      observe: sim.observe,
      look: sim.look,
      move: sim.move,
      tactician,
      log: (event, data) => events.push({ event, data }),
    },
    {
      mode: "execute",
      config,
      maxMoves: 400,
      maxSeconds: 120,
      maxJudgments: 60,
      signal: new AbortController().signal,
    }
  );
  return { summary, events, sim };
};

test("rules tactician finds, centres, grasps and lifts a piece off to the side", async () => {
  const { summary, events } = await runWith(
    rulesTactician(),
    matPiece(0.2, 0.09)
  );
  const skills = events
    .filter((e) => e.event === "skill_finished")
    .map((e) => `${String(e.data["skill"])}:${String(e.data["result"])}`);
  expect(summary.end_reason).toBe("done");
  expect(summary.task_complete).toBe(true);
  expect(skills).toContain("close_gripper:done");
  expect(skills.at(-1)).toBe("lift:done");
});

test("scan finds a piece outside the initial view", async () => {
  const { summary, events } = await runWith(
    rulesTactician(),
    matPiece(0.12, 0.17)
  );
  const skills = events
    .filter((e) => e.event === "skill_finished")
    .map((e) => String(e.data["skill"]));
  expect(skills[0]).toBe("scan_for_piece");
  expect(summary.end_reason).toBe("done");
});

test("the search never gives back the height it climbed", async () => {
  // On the real arm a "step outward" once lost 6 cm of height and the sweep
  // never left r = 0.16 m, because one solve was walked in joint space
  // without checking where the tip ended up.
  const { events, sim } = await runWith(rulesTactician(), matPiece(0.3, 0.14));
  const scanMoves = Number(
    events.find((e) => e.event === "skill_finished")?.data["moves"] ?? 0
  );
  expect(scanMoves).toBeGreaterThan(0);
  const heights = sim
    .tips()
    .slice(0, scanMoves)
    .map((t) => t[2] - config.matZ);
  let peak = 0;
  for (const h of heights) {
    peak = Math.max(peak, h);
    expect(h).toBeGreaterThan(peak - 0.015);
  }
});

test("a Jev tactician through the AI SDK evaluate path completes the pickup and reuses cached judgments", async () => {
  const tactician = jevTactician(
    mockTacticsEvaluator(
      memoryMeter({ input: 0.042e-6, output: 0, source: "test" }, 1)
    )
  );
  const { summary } = await runWith(tactician, matPiece(0.2, 0.09));
  expect(summary.end_reason).toBe("done");
  expect(summary.judgments).toBeGreaterThan(3);
});

test("code vetoes: done is refused until lifted, close is refused when high", async () => {
  const lying: Tactician = {
    name: "liar",
    judge: (scene) =>
      Promise.resolve({
        next:
          scene.observed.last_skill.name === null ? "done" : "close_gripper",
        probabilities: null,
        graspReady: null,
        risk: null,
        pieceHeld: null,
        source: "test",
        latencyMs: 0,
        costUsd: 0,
      }),
  };
  const { summary, events } = await runWith(lying, matPiece(0.2, 0.09));
  expect(summary.task_complete).toBe(false);
  expect(
    events.some(
      (e) =>
        e.event === "tactics" && String(e.data["veto"]).includes("done refused")
    )
  ).toBe(true);
  expect(
    events.some(
      (e) =>
        e.event === "skill_finished" &&
        e.data["skill"] === "close_gripper" &&
        e.data["result"] === "vetoed"
    )
  ).toBe(true);
});
