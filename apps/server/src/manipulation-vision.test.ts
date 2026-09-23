import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { Frame } from "@robo/domain";

import { cropFrame, requireFreshFrame } from "./manipulation-vision";

const frame: Frame = {
  id: "source",
  camera: "wrist",
  seq: 1,
  age_ms: 50,
  monotonic_s: 1,
  wall_time_ms: 1,
  clock_domain: "fixture",
  media_type: "image/jpeg",
  width: 640,
  height: 480,
  base64: readFileSync(
    import.meta.dir + "/decision/fixtures/wrist-2026-09-22/visible-141.1s.jpg"
  ).toString("base64"),
};

test("crop preserves source identity and the inverse pixel mapping", () => {
  const out = cropFrame(frame, { x: 0, y: 280, width: 100, height: 100 });
  expect(out.width).toBe(400);
  expect(out.height).toBe(400);
  expect(out.calibration?.["crop_to_source"]).toEqual([
    [0.25, 0, 0],
    [0, 0.25, 280],
    [0, 0, 1],
  ]);
  expect(out.calibration?.["source_frame_id"]).toBe("source");
  expect(out.base64).not.toBe(frame.base64);
  expect(out.wall_time_ms).toBe(frame.wall_time_ms);
});

test("stale frames and invalid crops are never supplied as current evidence", () => {
  expect(() => requireFreshFrame({ ...frame, age_ms: 1000 })).toThrow(
    "TRANSIENT_CAMERA"
  );
  expect(() =>
    cropFrame(frame, { x: 620, y: 0, width: 100, height: 100 })
  ).toThrow("inside");
});
