import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodeManipulationConfig,
  defaultManipulationPath,
  insidePolygon,
  loadManipulationConfig,
  pixelToTable,
} from "./manipulation-config";

test("an empty file decodes to the documented defaults", () => {
  expect(decodeManipulationConfig({})).toEqual({
    tcp_offset_m: [0, 0, 0],
    home_pose: null,
    safe_zone: { polygon: null, max_radius_m: 0.17 },
    approach_height_m: 0.05,
    table_z_m: -0.054,
    table_clearance_m: 0.015,
    workspace_table_homography: null,
    wrist_grasp_point_px: null,
  });
});

test("the committed lab file decodes", () => {
  const loaded = loadManipulationConfig(defaultManipulationPath);
  expect(loaded.status).toBe("loaded");
});

test("decoding is strict: unknown keys, bad shapes and nonsense values fail", () => {
  expect(() => decodeManipulationConfig({ tcp_offset: [0, 0, 0] })).toThrow();
  expect(() => decodeManipulationConfig({ tcp_offset_m: [0, 0] })).toThrow();
  expect(() =>
    decodeManipulationConfig({
      safe_zone: {
        polygon: [
          [0, 0],
          [1, 1],
        ],
      },
    })
  ).toThrow();
  expect(() =>
    decodeManipulationConfig({ safe_zone: { max_radius_m: -1 } })
  ).toThrow();
  expect(() => decodeManipulationConfig({ home_pose: { elbow: 3 } })).toThrow();
  expect(
    decodeManipulationConfig({ home_pose: { elbow_flex: 30, gripper: 20 } })
      .home_pose
  ).toEqual({ elbow_flex: 30, gripper: 20 });
});

test("a missing or invalid file is reported, not half-applied", () => {
  const dir = mkdtempSync(join(tmpdir(), "manipulation-"));
  expect(loadManipulationConfig(join(dir, "none.json")).status).toBe("absent");
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ approach_height_m: "high" }));
  const loaded = loadManipulationConfig(bad);
  expect(loaded.status).toBe("invalid");
});

test("the homography maps pixels to table metres and the polygon fences", () => {
  // Scale 1 mm per pixel, origin at pixel (100, 200).
  const h = [
    [0.001, 0, -0.1],
    [0, 0.001, -0.2],
    [0, 0, 1],
  ] as const;
  const xy = pixelToTable(h, 150, 260);
  expect(xy?.[0]).toBeCloseTo(0.05, 6);
  expect(xy?.[1]).toBeCloseTo(0.06, 6);
  expect(pixelToTable(null, 1, 1)).toBeNull();
  const square = [
    [0.1, -0.05],
    [0.2, -0.05],
    [0.2, 0.05],
    [0.1, 0.05],
  ] as const;
  expect(insidePolygon(square, 0.15, 0)).toBe(true);
  expect(insidePolygon(square, 0.25, 0)).toBe(false);
});
