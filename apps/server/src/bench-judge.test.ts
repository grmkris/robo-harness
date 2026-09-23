import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Frame } from "@robo/domain";

import {
  frameEvidence,
  judgeTrial,
  resetDecision,
  type TrialEvidence,
} from "./bench-judge";
import { decodeManipulationConfig } from "./manipulation-config";

const evidence = (overrides: Partial<TrialEvidence> = {}): TrialEvidence => ({
  target_xy_m: [0.1, 0.05],
  final_xy_m: [0.101, 0.051],
  gripper_stalled_at: 11.1,
  object_seen_in_jaws: true,
  object_left_original_spot: true,
  sam_pick: true,
  vlm_pick: true,
  claimed_success: true,
  failure_hint: null,
  ...overrides,
});
test("pickup requires stall above 8 percent plus CC and SAM evidence", () => {
  const result = judgeTrial(evidence());
  expect(result.pick_success).toBe(true);
  expect(result.place_error_m).toBeCloseTo(Math.hypot(0.001, 0.001), 8);
  expect(result.needs_review).toBe(false);
  expect(judgeTrial(evidence({ gripper_stalled_at: 6 })).pick_success).toBe(
    false
  );
  expect(judgeTrial(evidence({ sam_pick: false })).pick_success).toBe(false);
});
test("missing verification is unscored and disagreement is retained", () => {
  expect(judgeTrial(evidence({ sam_pick: null })).pick_success).toBeNull();
  expect(
    judgeTrial(evidence({ gripper_stalled_at: null, claimed_success: false }))
      .failure
  ).toBeNull();
  const disagree = judgeTrial(evidence({ vlm_pick: false }));
  expect(disagree.vlm_disagreement).toBe(true);
  expect(disagree.needs_review).toBe(true);
  expect(judgeTrial(evidence({ object_seen_in_jaws: false })).failure).toBe(
    "false_success"
  );
});
test("reset reobserves an unknown position and pauses after three failures", () => {
  const state = {
    attempts: 0,
    max_attempts: 3,
    current_xy_m: [0.1, 0.1] as const,
    target_xy_m: [0.1, 0.05] as const,
  };
  expect(resetDecision(state)).toBe("run_reset");
  expect(resetDecision({ ...state, current_xy_m: null })).toBe("reobserve");
  expect(resetDecision({ ...state, attempts: 3, current_xy_m: null })).toBe(
    "pause_after_failures"
  );
  expect(resetDecision({ ...state, current_xy_m: [0.1, 0.05] })).toBe(
    "already_in_place"
  );
});
const recorded = (name: string): Frame => ({
  id: name,
  camera: "wrist",
  seq: 1,
  monotonic_s: 1,
  wall_time_ms: 1,
  clock_domain: "recording-d9d2cfd7",
  age_ms: 0,
  width: 640,
  height: 480,
  media_type: "image/jpeg",
  base64: readFileSync(
    join(import.meta.dir, "decision/fixtures/wrist-2026-09-22", name)
  ).toString("base64"),
});
test("saved wrist frames provide jaw-location evidence without inventing calibration", () => {
  const visible = recorded("visible-141.1s.jpg");
  const absent = recorded("absent-030.0s.jpg");
  const config = decodeManipulationConfig({
    wrist_grasp_point_px: { x: 20, y: 330 },
  });
  // These saved views test the detector only. Their wrist provenance must remain intact.
  const result = frameEvidence({
    before: visible,
    after: absent,
    liftWorkspace: null,
    liftWrist: visible,
    config,
  });
  expect(result.object_seen_in_jaws).toBe(true);
  expect(result.object_left_original_spot).toBeNull();
  expect(result.final_xy_m).toBeNull();
  expect(result.source_frame_ids.lift_wrist).toBe(visible.id);
  expect(
    frameEvidence({
      before: visible,
      after: absent,
      liftWorkspace: null,
      liftWrist: absent,
      config,
    }).object_seen_in_jaws
  ).toBe(false);
});

test("wrist provenance cannot supply table evidence even with a homography", () => {
  const visible = recorded("visible-141.1s.jpg");
  const config = decodeManipulationConfig({
    wrist_grasp_point_px: { x: 20, y: 330 },
    workspace_table_homography: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  });
  const result = frameEvidence({
    before: visible,
    after: visible,
    liftWorkspace: visible,
    liftWrist: visible,
    config,
  });
  expect(result.final_xy_m).toBeNull();
  expect(result.object_left_original_spot).toBeNull();
  expect(result.candidate_counts).toEqual({ before: 0, after: 0 });
  // Deliberately mismatched role in this contract test, not calibration evidence.
  expect(
    frameEvidence({
      before: visible,
      after: visible,
      liftWorkspace: null,
      liftWrist: { ...visible, camera: "workspace" },
      config,
    }).object_seen_in_jaws
  ).toBeNull();
});
