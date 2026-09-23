import { expect, test } from "bun:test";

import {
  assertBenchReady,
  makeSchedule,
  stopReason,
  trialDirectory,
  type BenchConfig,
} from "./bench";

const config: BenchConfig = {
  commissioned: true,
  safe_zone: {
    polygon: [
      [0.04, -0.12],
      [0.17, -0.12],
      [0.17, 0.12],
      [0.04, 0.12],
    ],
    max_radius_m: 0.17,
  },
  home_pose: {
    shoulder_pan: 0,
    shoulder_lift: -40,
    elbow_flex: 50,
    wrist_flex: 80,
    wrist_roll: 0,
  },
  tcp_offset_m: [0, 0, 0.023],
  workspace_table_homography: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
};

test("schedule is seeded, spaced, fenced and rotates models", () => {
  const a = makeSchedule(config, ["a", "b", "c"], 12, 7);
  const b = makeSchedule(config, ["a", "b", "c"], 12, 7);
  expect(a).toEqual(b);
  expect(a.map((slot) => slot.model)).toEqual([
    "a",
    "b",
    "c",
    "a",
    "b",
    "c",
    "a",
    "b",
    "c",
    "a",
    "b",
    "c",
  ]);
  for (const [i, slot] of a.entries()) {
    expect(Math.hypot(...slot.target)).toBeLessThanOrEqual(0.17);
    for (const other of a.slice(i + 1)) {
      expect(
        Math.hypot(
          slot.target[0] - other.target[0],
          slot.target[1] - other.target[1]
        )
      ).toBeGreaterThanOrEqual(0.03);
    }
  }
});

test("schedule refuses an uncommissioned profile", () => {
  expect(() => assertBenchReady({ ...config, commissioned: false })).toThrow(
    "uncommissioned"
  );
  expect(() => makeSchedule({ ...config, home_pose: null }, ["a"], 1)).toThrow(
    "home pose"
  );
});

test("stop conditions are fail-closed", () => {
  const good = {
    fault: null,
    temperatures: {
      shoulder_pan: 40,
      shoulder_lift: 40,
      elbow_flex: 40,
      wrist_flex: 40,
      wrist_roll: 40,
      gripper: 40,
    },
    cameras: {
      workspace: { age_ms: 30, error: null },
      wrist: { age_ms: 30, error: null },
    },
  };
  expect(stopReason(good, "/definitely/not-present")).toBeNull();
  expect(
    stopReason({ ...good, fault: "latched" }, "/definitely/not-present")
  ).toContain("fault");
  expect(
    stopReason(
      { ...good, temperatures: { elbow: 61 } },
      "/definitely/not-present"
    )
  ).toContain("temperature");
  expect(
    stopReason(
      {
        ...good,
        cameras: { ...good.cameras, wrist: { age_ms: 501, error: null } },
      },
      "/definitely/not-present"
    )
  ).toContain("wrist");
});

test("trial evidence directories are bounded and deterministic", () => {
  expect(trialDirectory("2026-09-23", 4)).toEndWith("trial-04");
  expect(() => trialDirectory("not-a-night", 1)).toThrow();
  expect(() => trialDirectory("2026-09-23", -1)).toThrow();
});
