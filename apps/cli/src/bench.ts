#!/usr/bin/env bun
/**
 * Benchmark schedule preflight. No mode in this command moves the robot.
 *
 * This file owns task-specific scheduling and stop conditions. Models only see
 * the general manipulation tools through /api/chat. The runner refuses to
 * admit a trial until the reviewed manipulation config is commissioned.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { Effect, Schema } from "effect";

type Point = readonly [number, number];

const Vec3 = Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite]);
const PointSchema = Schema.Tuple([Schema.Finite, Schema.Finite]);
const BenchConfigSchema = Schema.Struct({
  commissioned: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  ),
  safe_zone: Schema.Struct({
    polygon: Schema.NullOr(
      Schema.Array(PointSchema).check(Schema.isMinLength(3))
    ),
    max_radius_m: Schema.Finite.check(
      Schema.isBetween({ minimum: 0.01, maximum: 0.17 })
    ),
  }),
  home_pose: Schema.NullOr(Schema.Record(Schema.String, Schema.Finite)),
  tcp_offset_m: Vec3,
  workspace_table_homography: Schema.NullOr(Schema.Tuple([Vec3, Vec3, Vec3])),
});
export type BenchConfig = typeof BenchConfigSchema.Type;
export const decodeBenchConfig = (input: unknown): BenchConfig =>
  Schema.decodeUnknownSync(BenchConfigSchema)(input);

export interface TrialSlot {
  readonly index: number;
  readonly model: string;
  readonly target: Point;
}

export interface StopStatus {
  readonly fault: string | null;
  readonly temperatures: Record<string, number> | null | undefined;
  readonly cameras: Record<
    string,
    { readonly age_ms: number | null; readonly error: string | null }
  >;
}

const inside = (polygon: readonly Point[], x: number, y: number): boolean => {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] ?? [0, 0];
    const [xj, yj] = polygon[j] ?? [0, 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      hit = !hit;
  }
  return hit;
};

const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const random = (seed: number) => {
  let value = seed;
  return () => {
    value = (1_664_525 * value + 1_013_904_223) % 4_294_967_296;
    return value / 4_294_967_296;
  };
};

export const assertBenchReady = (config: BenchConfig): void => {
  if (!config.commissioned)
    throw new Error(
      "Benchmark is gated: manipulation config is uncommissioned"
    );
  if (!config.safe_zone.polygon || config.safe_zone.polygon.length < 3)
    throw new Error("Benchmark is gated: safe polygon is absent");
  if (
    !config.home_pose ||
    [
      "shoulder_pan",
      "shoulder_lift",
      "elbow_flex",
      "wrist_flex",
      "wrist_roll",
    ].some((joint) => !Number.isFinite(config.home_pose?.[joint]))
  )
    throw new Error("Benchmark is gated: home pose is absent");
  if (!config.workspace_table_homography)
    throw new Error("Benchmark is gated: workspace homography is absent");
  if (config.tcp_offset_m.every((value) => value === 0))
    throw new Error("Benchmark is gated: TCP offset is not commissioned");
};

/** Deterministic points inside the reviewed polygon, spaced for reset safety. */
export const makeSchedule = (
  config: BenchConfig,
  models: readonly string[],
  count = 32,
  seed = 2_416_972_340,
  spacingM = 0.03
): readonly TrialSlot[] => {
  assertBenchReady(config);
  if (models.length === 0) throw new Error("At least one model is required");
  if (!Number.isSafeInteger(count) || count < 1 || count > 32)
    throw new Error("Schedule count must be an integer from 1 to 32");
  if (!Number.isFinite(spacingM) || spacingM < 0.03)
    throw new Error("Target spacing must be at least 3 cm");
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 4_294_967_295)
    throw new Error("Invalid schedule seed");
  if (models.includes("claude-opus-5-5"))
    throw new Error(
      "Schedule Opus separately after primary models, at most two trials"
    );
  const polygon = config.safe_zone.polygon;
  if (!polygon) throw new Error("Safe polygon is absent");
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const sample = random(seed);
  const points: Point[] = [];
  for (
    let attempt = 0;
    attempt < count * 20_000 && points.length < count;
    attempt += 1
  ) {
    const point: Point = [
      minX + sample() * (maxX - minX),
      minY + sample() * (maxY - minY),
    ];
    if (Math.hypot(point[0], point[1]) > config.safe_zone.max_radius_m)
      continue;
    if (!inside(polygon, point[0], point[1])) continue;
    if (points.some((previous) => distance(previous, point) < spacingM))
      continue;
    points.push(point);
  }
  if (points.length !== count)
    throw new Error(
      `Could only place ${points.length}/${count} scheduled targets`
    );
  return points.map((target, index) => ({
    index,
    model: models[index % models.length] ?? models[0]!,
    target,
  }));
};

export const stopReason = (
  status: StopStatus,
  stopFile = resolve("var/bench/2026-09-23/STOP")
): string | null => {
  if (existsSync(stopFile)) return "STOP file present";
  if (status.fault) return `latched fault: ${status.fault}`;
  if (
    Object.values(status.temperatures ?? {}).some(
      (temperature) => temperature > 60
    )
  )
    return "servo temperature above 60 C";
  if (
    !status.temperatures ||
    [
      "shoulder_pan",
      "shoulder_lift",
      "elbow_flex",
      "wrist_flex",
      "wrist_roll",
      "gripper",
    ].some((joint) => !Number.isFinite(status.temperatures?.[joint]))
  )
    return "servo temperatures unavailable";
  for (const camera of ["workspace", "wrist"]) {
    const value = status.cameras[camera];
    if (
      !value ||
      value.error ||
      value.age_ms === null ||
      !Number.isFinite(value.age_ms) ||
      value.age_ms < 0 ||
      value.age_ms > 500
    )
      return `${camera} camera is stale or unavailable`;
  }
  return null;
};

/** Pure path builder; the evidence writer creates directories exclusively. */
export const trialDirectory = (night: string, index: number): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(night)) throw new Error("Invalid night");
  if (!Number.isInteger(index) || index < 0 || index > 999)
    throw new Error("Invalid trial index");
  const path = resolve(
    "var/bench",
    night,
    `trial-${String(index).padStart(2, "0")}`
  );
  return path;
};

const readConfig = async (): Promise<BenchConfig> =>
  decodeBenchConfig(
    await Bun.file(
      process.env["ROBO_MANIPULATION_CONFIG"] ??
        resolve(import.meta.dir, "../../../config/manipulation.lab-pi.json")
    ).json()
  );

if (import.meta.main) {
  const count = Number(
    process.argv.find((arg) => arg.startsWith("--count="))?.slice(8) ?? 32
  );
  const models = (
    process.env["ROBO_CLIPROXY_MODELS"] ?? "gpt-6-astra,grok-4.7,qwen3.8-max"
  )
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  try {
    const config = await readConfig();
    const schedule = makeSchedule(config, models, count);
    console.log(JSON.stringify(schedule, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
