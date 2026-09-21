import { expect, test } from "bun:test";

import {
  rasterCoverage,
  skillDefaults,
  wristFootprintM,
  type SkillConfig,
} from "./skills";

// The three-arc raster is only sufficient because the camera sees further
// than the raster steps. That was a comment and nothing else until now, which
// is how a run sweeps its whole budget and reports "found nothing" about mat
// it never actually looked at.

const limits = {
  shoulder_pan: [-111.9, 111.9],
  shoulder_lift: [-111.3, 111.3],
  elbow_flex: [-98.4, 98.4],
  wrist_flex: [-103, 103],
  wrist_roll: [-180, 180],
  gripper: [0, 100],
} as const;

const config = (over: Partial<SkillConfig> = {}): SkillConfig => ({
  ...skillDefaults,
  limits,
  ...over,
});

test("the footprint grows with height and is zero on the mat", () => {
  expect(wristFootprintM(config(), 0.1)).toBeCloseTo(0.208, 3);
  expect(wristFootprintM(config(), 0.05)).toBeCloseTo(0.104, 3);
  expect(wristFootprintM(config(), 0)).toBe(0);
  // A tip below the mat is not a negative field of view.
  expect(wristFootprintM(config(), -0.05)).toBe(0);
});

test("the shipped search raster tiles the mat it sweeps", () => {
  const coverage = rasterCoverage(config());
  expect(coverage.tiles).toBe(true);
  expect(coverage.footprintM).toBeGreaterThan(coverage.worstStepM);
});

test("both gap directions are measured, not just the radial one", () => {
  const coverage = rasterCoverage(config());
  // Arcs are 5 cm apart.
  expect(coverage.radialStepM).toBeCloseTo(0.05, 3);
  // Two capped moves of pan at the widest arc, 3.2 deg at 0.22 m.
  expect(coverage.angularStepM).toBeCloseTo(0.0123, 3);
  expect(coverage.worstStepM).toBe(coverage.radialStepM);
});

test("a raster that outsteps the camera is refused", () => {
  // Arcs a quarter metre apart at a scan height that sees ~0.2 m.
  const coverage = rasterCoverage(config({ scanReachStepM: -0.25 }));
  expect(coverage.tiles).toBe(false);
  expect(coverage.worstStepM).toBeCloseTo(0.25, 3);
});

test("sweeping too low to see leaves gaps even at the shipped step", () => {
  // A 3 cm hover sees about 6 cm of mat, less than the 5 cm arc step plus any
  // margin: this is the 2026-09-17 failure, where a sagging arm swept blind.
  const coverage = rasterCoverage(config({ scanHeightM: 0.02 }));
  expect(coverage.tiles).toBe(false);
});

test("a narrower camera than assumed is caught", () => {
  // Halve the assumed field of view and the shipped raster no longer tiles,
  // so the assumption is load-bearing rather than decorative.
  const coverage = rasterCoverage(config({ wristFootprintRatio: 0.4 }));
  expect(coverage.tiles).toBe(false);
});
