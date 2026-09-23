import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

import jpeg from "jpeg-js";

import { replayTrial } from "./bench-replay";

// Synthetic black views exercise archival contracts, never object recognition.
const bytes = jpeg.encode(
  { width: 64, height: 64, data: Buffer.alloc(64 * 64 * 4) },
  90
).data;
const metadata = (id: string, seq: number) => ({
  id,
  camera: "workspace",
  seq,
  monotonic_s: seq,
  wall_time_ms: seq,
  clock_domain: "fixture",
  age_ms: 1,
  width: 64,
  height: 64,
  media_type: "image/jpeg",
  calibration: null,
  image: "workspace.jpg",
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
const fixture = async () => {
  const root = await mkdtemp("/tmp/bench-replay-");
  for (const phase of ["before", "after"]) {
    await mkdir(join(root, phase));
    await writeFile(join(root, phase, "workspace.jpg"), bytes);
    await writeFile(
      join(root, phase, "workspace.json"),
      JSON.stringify(metadata(phase, phase === "before" ? 1 : 3))
    );
  }
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({ commissioned: false })
  );
  const manifest = {
    kind: "offline_fixture",
    config: "config.json",
    before: "before/workspace.json",
    after: "after/workspace.json",
    lift_workspace: null,
    lift_wrist: null,
    target_xy_m: [0.1, 0.05],
    gripper_stalled_at: null,
    claimed_success: false,
    failure_hint: null,
    // Supplied checks for other frames must not verify this trial.
    sam: { value: true, frame_ids: ["foreign"], method: "synthetic fixture" },
    vlm: { value: true, frame_ids: ["foreign"], method: "synthetic fixture" },
  };
  const path = join(root, "trial.json");
  await writeFile(path, JSON.stringify(manifest));
  return { root, path };
};

test("replay retains missing or mismatched verification as unverified", async () => {
  const { root, path } = await fixture();
  try {
    const result = await replayTrial(path);
    expect(result.commissioned).toBe(false);
    expect(result.judgement.pick_success).toBeNull();
    expect(result.judgement.place_error_m).toBeNull();
    expect(result.judgement.needs_review).toBe(true);
    expect(result.evidence.sam_pick).toBeNull();
    expect(result.evidence.vlm_pick).toBeNull();
    expect(result.external_checks.sam?.frame_ids).toEqual(["foreign"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replay refuses changed pixels, camera roles and reordered or foreign-clock evidence", async () => {
  const { root, path } = await fixture();
  const source = join(root, "after/workspace.json");
  try {
    for (const [patch, reason] of [
      [{ sha256: "0".repeat(64) }, "hash mismatch"],
      [{ camera: "wrist" }, "camera/image mismatch"],
      [{ seq: 1, monotonic_s: 1 }, "out of order"],
      [{ clock_domain: "rebooted" }, "crosses robot clocks"],
      [{ age_ms: 501 }, "stale at capture"],
    ] as const) {
      await writeFile(
        source,
        JSON.stringify({ ...metadata("after", 3), ...patch })
      );
      const result = await replayTrial(path).catch((error: unknown) => error);
      expect(String(result)).toContain(reason);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
