import { expect, test } from "bun:test";

import { downness, position, reach, tipFrame } from "./kinematics";
import vectors from "./kinematics.fixture.json";

const limits = {
  shoulder_pan: [-111.8, 111.8],
  shoulder_lift: [-111.3, 111.3],
  elbow_flex: [-98.4, 98.4],
  wrist_flex: [-103, 103],
} as const;

test("forward kinematics matches the Python URDF implementation", () => {
  for (const vector of vectors) {
    const m = tipFrame(vector.pose);
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        expect(m[r]?.[c]).toBeCloseTo(vector.matrix[r]?.[c] ?? Number.NaN, 5);
      }
    }
  }
});

test("reach finds a top-down pose for a point on the mat", () => {
  const start = {
    shoulder_pan: 1.1,
    shoulder_lift: -0.2,
    elbow_flex: 29.1,
    wrist_flex: 69.5,
    wrist_roll: -8.9,
    gripper: 50,
  };
  const target: [number, number, number] = [0.2, 0.05, -0.02];
  const result = reach(start, target, limits);
  expect(result.errorM).toBeLessThan(0.003);
  expect(result.downness).toBeGreaterThan(0.98);
  const [x, y, z] = position(tipFrame(result.pose));
  expect([x, y, z].map((v) => Math.round(v * 100))).toEqual([20, 5, -2]);
  expect(downness(tipFrame(result.pose))).toBeGreaterThan(0.98);
});
