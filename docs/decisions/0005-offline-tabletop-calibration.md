# 0005: Validate tabletop geometry offline before using it for motion

Status: accepted, 2026-09-08.

The perception worker currently emits segmentation in pixels and DA3 depth in relative units. The lab camera profile has no commissioned camera geometry. A predicted depth image or a visually plausible fit is insufficient evidence for an arm target.

Introduce an offline `robo-calibrate` CLI for a fixed workspace camera and one measured plane. Calibration artifacts retain original measurements, fit/check separation, image identity, camera setup identity, coordinate frame, plane height and an explicit task tolerance. A normalized homography is fitted to at least six points and evaluated against at least three independent, non-collinear check points. Re-evaluation of later frames reuses the original fit and produces separate evidence rather than overwriting it.

These artifacts are deliberately separate from the runtime camera calibration record. A planar homography does not supply intrinsics, hand-eye extrinsics or an arbitrary-height grasp pose, and it cannot authorize robot motion. Promotion to runtime geometry will require a separate, explicit contract and measured commissioning. The moving wrist camera is outside this initial scope.

Use existing Python numerical/image dependencies and retain all fit residuals rather than silently removing outliers. A report marks whether a requested tolerance was met on labelled points; it is not a general safety or accuracy certification. Image overlays expose labelling and projection errors to the operator. No inference provider or motor owner participates in this workflow.

See [the measurement and evaluation procedure](../tabletop-calibration.md).
