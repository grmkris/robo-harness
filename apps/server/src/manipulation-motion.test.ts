import { expect, test } from "bun:test";

import type { Observation } from "@robo/domain";

import { simArm } from "./decision/sim-arm";
import type { MoveOutcome } from "./decision/skills";
import type { ManipulationConfig } from "./manipulation-config";
import { manipulationMotion, tcpPosition } from "./manipulation-motion";

const start = {
  shoulder_pan: 23.8,
  shoulder_lift: -38.1,
  elbow_flex: 64.1,
  wrist_flex: 62.8,
  wrist_roll: 0.2,
  gripper: 60,
};

const config: ManipulationConfig = {
  commissioned: true,
  speed_units_s: 1.4,
  tcp_offset_m: [0, 0, 0],
  home_pose: start,
  safe_zone: {
    polygon: [
      [0.04, -0.12],
      [0.2, -0.12],
      [0.2, 0.12],
      [0.04, 0.12],
    ],
    max_radius_m: 0.17,
  },
  approach_height_m: 0.05,
  table_z_m: -0.054,
  table_clearance_m: 0.015,
  workspace_table_homography: null,
  wrist_grasp_point_px: null,
};

const harness = (staleAt: readonly number[] = []) => {
  const sim = simArm({ start, tableZ: config.table_z_m, staleAt });
  const observe = async (): Promise<Observation> => ({
    ...(await sim.observe()),
    temperatures: {
      shoulder_pan: 28,
      shoulder_lift: 28,
      elbow_flex: 28,
      wrist_flex: 28,
      wrist_roll: 28,
      gripper: 28,
    },
  });
  const move = async (
    target: Partial<Record<keyof typeof start, number>>,
    _duration: number
  ): Promise<MoveOutcome> => {
    const result = await sim.move(target);
    return { ...result, after: await observe() };
  };
  return { sim, observe, move };
};

test("move_tcp uses the configured TCP and fenced path", async () => {
  const h = harness();
  const before = await h.observe();
  const from = tcpPosition(before, config);
  const run = manipulationMotion(config, {
    observe: h.observe,
    move: h.move,
    signal: new AbortController().signal,
  });
  const result = await run.moveTcp([from[0] + 0.004, from[1], from[2]]);
  expect(result.status).toBe("completed");
  expect(result.reached).toBe(true);
  expect(result.tcp_xyz_m[0]).toBeCloseTo(from[0] + 0.004, 2);
});

test("TCP progress reports the motor owner's completion deadband without retrying", async () => {
  const h = harness();
  let stationarySteps = 0;
  const from = tcpPosition(await h.observe(), config);
  const run = manipulationMotion(config, {
    observe: h.observe,
    signal: new AbortController().signal,
    move: async (target, duration) => {
      const before = await h.observe();
      const measured = { ...target };
      for (const joint of Object.keys(target) as (keyof typeof start)[]) {
        const delta = target[joint]! - before.measured[joint];
        measured[joint] =
          before.measured[joint] +
          Math.sign(delta) * Math.max(0, Math.abs(delta) - 0.6);
      }
      if (
        Object.entries(measured).every(
          ([joint, value]) =>
            value === before.measured[joint as keyof typeof start]
        )
      )
        stationarySteps += 1;
      return h.move(measured, duration);
    },
  });
  const result = await run.moveTcp([from[0], from[1], from[2] + 0.035]);
  // The remaining 2.3 mm error is reported honestly; do not hammer the same
  // sub-deadband joint goal to make the helper declare completion.
  expect(result.reached).toBe(false);
  expect(result.tcp_xyz_m[2]).toBeGreaterThan(from[2] + 0.032);
  expect(stationarySteps).toBe(0);
});

test("stale protection stops without retrying the failed step", async () => {
  const h = harness([1]);
  const before = await h.observe();
  const from = tcpPosition(before, config);
  const run = manipulationMotion(config, {
    observe: h.observe,
    move: h.move,
    signal: new AbortController().signal,
  });
  const result = await run
    .moveTcp([from[0] + 0.004, from[1], from[2]])
    .catch((error: unknown) => error);
  expect(String(result)).toContain("TRANSIENT_CAMERA");
  expect(h.sim.moves()).toBe(1);
});

test("descent stops at the first contact without another motor write", async () => {
  const sim = simArm({ start, tableZ: config.table_z_m, jawReachM: 0.03 });
  const run = manipulationMotion(config, {
    ...sim,
    signal: new AbortController().signal,
  });
  const out = await run.descend(0.05);
  expect(out.contact).toBe(true);
  expect(out.stopped).toBe("first_failed_step");
  expect(sim.log().at(-1)?.status).toBe("contact");
  expect(sim.log().filter((step) => step.status === "contact")).toHaveLength(1);
});

test("fences and temperatures refuse motion before the first write", async () => {
  const h = harness();
  const run = manipulationMotion(config, {
    ...h,
    signal: new AbortController().signal,
  });
  const outside = await run
    .moveTcp([0.21, 0, 0.05])
    .catch((error: unknown) => error);
  expect(String(outside)).toContain("UNSAFE_TARGET");
  expect(h.sim.moves()).toBe(0);
  const hot = manipulationMotion(config, {
    ...h,
    signal: new AbortController().signal,
    observe: async () => ({
      ...(await h.observe()),
      temperatures: { shoulder_lift: 61 },
    }),
  });
  expect(String(await hot.grip(0).catch((error: unknown) => error))).toContain(
    "60 C"
  );
  expect(h.sim.moves()).toBe(0);
});

test("gripper reports first resistance without retrying", async () => {
  const h = harness();
  const xyz = tcpPosition(await h.observe(), config);
  const sim = simArm({
    start,
    tableZ: config.table_z_m,
    objects: [
      { x: xyz[0], y: xyz[1], heightM: 0.08, radiusM: 0.02, widthPercent: 12 },
    ],
  });
  const run = manipulationMotion(config, {
    ...sim,
    signal: new AbortController().signal,
  });
  const out = await run.grip(0);
  expect(out.stalled_at).toBe(12);
  expect(sim.log().filter((step) => step.status === "stalled")).toHaveLength(1);
  expect(sim.log().at(-1)?.status).toBe("stalled");
});

test("commissioning and cancellation cannot submit motion", async () => {
  const h = harness();
  const run = manipulationMotion(
    { ...config, commissioned: false },
    { ...h, signal: new AbortController().signal }
  );
  expect(String(await run.grip(0).catch((error: unknown) => error))).toContain(
    "commissioned"
  );
  const aborted = new AbortController();
  aborted.abort();
  const cancelled = manipulationMotion(config, {
    ...h,
    signal: aborted.signal,
  });
  expect(await cancelled.grip(0).catch(() => "aborted")).toBe("aborted");
  expect(h.sim.moves()).toBe(0);
});

test("a lateral TCP offset rotates with wrist roll and remains the motion target", async () => {
  const h = harness();
  const tcpConfig = { ...config, tcp_offset_m: [0.006, 0.002, 0.023] as const };
  const before = await h.observe();
  const from = tcpPosition(before, tcpConfig);
  const rotated = tcpPosition(
    { ...before, measured: { ...before.measured, wrist_roll: 90 } },
    tcpConfig
  );
  expect(
    Math.hypot(rotated[0] - from[0], rotated[1] - from[1])
  ).toBeGreaterThan(0.005);
  const run = manipulationMotion(tcpConfig, {
    ...h,
    signal: new AbortController().signal,
  });
  const out = await run.moveTcp([from[0] + 0.006, from[1], from[2] + 0.003]);
  expect(out.reached).toBe(true);
  expect(
    Math.hypot(
      out.tcp_xyz_m[0] - from[0] - 0.006,
      out.tcp_xyz_m[1] - from[1],
      out.tcp_xyz_m[2] - from[2] - 0.003
    )
  ).toBeLessThan(0.0021);
  expect(h.sim.moves()).toBeGreaterThan(0);
});
