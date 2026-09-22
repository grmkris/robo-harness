import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Frame } from "@robo/domain";

import { brightComponents, whiteBlob } from "./blob";

/**
 * Real wrist frames from recording d9d2cfd7 (2026-09-22, lamp on). In the
 * "visible" frames the white object lies on the mat against the left edge of
 * the image, with white table filling the right half; in the "absent" frames
 * the camera sees only table, cables, the mat and the gripper finger. The old
 * single-bounding-box detector called all eight "background".
 */
const directory = join(import.meta.dir, "fixtures/wrist-2026-09-22");

const frameOf = (name: string): Frame => ({
  id: name,
  camera: "wrist",
  seq: 1,
  monotonic_s: 1,
  wall_time_ms: 1,
  clock_domain: "fixture",
  age_ms: 30,
  width: 640,
  height: 480,
  media_type: "image/jpeg",
  base64: readFileSync(join(directory, name)).toString("base64"),
});

const files = readdirSync(directory).filter((name) => name.endsWith(".jpg"));

test("real wrist fixtures stay small and cover both cases", () => {
  const bytes = files.reduce(
    (sum, name) => sum + readFileSync(join(directory, name)).byteLength,
    0
  );
  expect(bytes).toBeLessThan(1_000_000);
  expect(files.filter((name) => name.startsWith("visible")).length).toBe(4);
  expect(files.filter((name) => name.startsWith("absent")).length).toBe(4);
});

test.each(files.filter((name) => name.startsWith("visible")))(
  "finds the object beside the table in %s",
  (name) => {
    const found = brightComponents(frameOf(name));
    expect(found.best).not.toBeNull();
    // The object sits against the left edge, lower middle of the image.
    expect(found.best?.centerX ?? 999).toBeLessThan(60);
    expect(found.best?.centerY ?? 0).toBeGreaterThan(280);
    expect(found.best?.centerY ?? 999).toBeLessThan(400);
    // The table is still seen, and rejected on its own.
    expect(found.background).toBe(true);
    const detection = whiteBlob(frameOf(name));
    expect(detection["visible"]).toBe(true);
    expect(detection["background"]).toBe(false);
    expect(detection["center_x"] as number).toBeLessThan(-0.8);
  }
);

test.each(files.filter((name) => name.startsWith("absent")))(
  "reports nothing but background in %s",
  (name) => {
    const found = brightComponents(frameOf(name));
    expect(found.best).toBeNull();
    expect(found.background).toBe(true);
    const detection = whiteBlob(frameOf(name));
    expect(detection["visible"]).toBe(false);
    expect(detection["background"]).toBe(true);
    expect(detection["center_x"]).toBeNull();
  }
);
