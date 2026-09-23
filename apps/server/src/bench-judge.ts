import type { Frame } from "@robo/domain";
import { Schema } from "effect";

import { brightComponents } from "./decision/blob";
import { pixelToTable, type ManipulationConfig } from "./manipulation-config";

const Point = Schema.Tuple([Schema.Finite, Schema.Finite]);
const Check = Schema.NullOr(Schema.Boolean);
const Failure = Schema.Literals([
  "alignment",
  "reach",
  "pushed_object",
  "tool_misuse",
  "hardware",
]);
export const TrialEvidence = Schema.Struct({
  target_xy_m: Point,
  final_xy_m: Schema.NullOr(Point),
  gripper_stalled_at: Schema.NullOr(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
  ),
  object_seen_in_jaws: Check,
  object_left_original_spot: Check,
  sam_pick: Check,
  vlm_pick: Check,
  claimed_success: Schema.Boolean,
  failure_hint: Schema.NullOr(Failure),
});
export type TrialEvidence = typeof TrialEvidence.Type;

/** Missing visual confirmation is unverified, never a successful pick. */
export const judgeTrial = (input: TrialEvidence) => {
  const mechanical =
    input.gripper_stalled_at === null ? null : input.gripper_stalled_at > 8;
  const checks = new Set([
    mechanical,
    input.object_seen_in_jaws,
    input.object_left_original_spot,
    input.sam_pick,
  ]);
  const pick = checks.has(false) ? false : checks.has(null) ? null : true;
  const placeError =
    input.final_xy_m === null
      ? null
      : Math.hypot(
          input.final_xy_m[0] - input.target_xy_m[0],
          input.final_xy_m[1] - input.target_xy_m[1]
        );
  const disagreement =
    pick !== null && input.vlm_pick !== null && pick !== input.vlm_pick;
  return {
    pick_success: pick,
    place_error_m: placeError,
    place_within_3cm: placeError === null ? null : placeError <= 0.03,
    vlm_disagreement: disagreement,
    needs_review:
      pick === null ||
      input.vlm_pick === null ||
      disagreement ||
      placeError === null,
    failure:
      input.failure_hint ??
      (input.claimed_success && pick === false ? "false_success" : null),
    unverified: checks.has(null),
  };
};

/** CC evidence is tied to the recorded frames, independent of model claims. */
export const frameEvidence = (input: {
  before: Frame;
  liftWorkspace: Frame | null;
  liftWrist: Frame | null;
  after: Frame;
  config: ManipulationConfig;
}) => {
  const before =
    input.before.camera === "workspace" ? brightComponents(input.before) : null;
  const after =
    input.after.camera === "workspace" ? brightComponents(input.after) : null;
  const lift =
    input.liftWorkspace?.camera === "workspace"
      ? brightComponents(input.liftWorkspace)
      : null;
  const wrist =
    input.liftWrist?.camera === "wrist"
      ? brightComponents(input.liftWrist)
      : null;
  const distinct = (found: ReturnType<typeof brightComponents>) =>
    found.candidates.filter((candidate) => candidate.rejected === null);
  const beforeCandidates = before ? distinct(before) : [];
  const afterCandidates = after ? distinct(after) : [];
  const original = beforeCandidates.length === 1 ? beforeCandidates[0] : null;
  const final = afterCandidates.length === 1 ? afterCandidates[0] : null;
  const graspPoint = input.config.wrist_grasp_point_px;
  const atGrasp =
    graspPoint && wrist
      ? distinct(wrist).some((candidate) => {
          const [left, top, right, bottom] = candidate.bbox;
          return (
            graspPoint.x >= left &&
            graspPoint.x <= right &&
            graspPoint.y >= top &&
            graspPoint.y <= bottom
          );
        })
      : null;
  const leftOriginal =
    original && lift
      ? !distinct(lift).some(
          (candidate) =>
            Math.hypot(
              candidate.centerX - original.centerX,
              candidate.centerY - original.centerY
            ) < 20
        )
      : null;
  return {
    object_seen_in_jaws: atGrasp,
    object_left_original_spot: leftOriginal,
    // The lower box edge approximates support on the table; retain this label.
    final_xy_m: final
      ? pixelToTable(
          input.config.workspace_table_homography,
          (final.bbox[0] + final.bbox[2]) / 2,
          final.bbox[3]
        )
      : null,
    placement_method:
      "CC lower-box table-plane estimate; parallax/contact uncertainty remains",
    source_frame_ids: {
      before: input.before.id,
      lift_workspace: input.liftWorkspace?.id ?? null,
      lift_wrist: input.liftWrist?.id ?? null,
      after: input.after.id,
    },
    candidate_counts: {
      before: beforeCandidates.length,
      after: afterCandidates.length,
    },
  };
};

const ResetState = Schema.Struct({
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  max_attempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  current_xy_m: Schema.NullOr(Point),
  target_xy_m: Point,
});
type ResetState = typeof ResetState.Type;
export const resetDecision = (
  state: ResetState
): "already_in_place" | "run_reset" | "pause_after_failures" | "reobserve" => {
  if (
    state.current_xy_m &&
    Math.hypot(
      state.current_xy_m[0] - state.target_xy_m[0],
      state.current_xy_m[1] - state.target_xy_m[1]
    ) <= 0.03
  )
    return "already_in_place";
  if (state.attempts >= state.max_attempts) return "pause_after_failures";
  if (!state.current_xy_m) return "reobserve";
  return "run_reset";
};
