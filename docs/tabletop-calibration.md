# Tabletop calibration and evaluation

`robo-calibrate` fits an offline mapping from a **fixed workspace camera's pixels to measured points on one plane**. It uses the existing NumPy/SciPy/Pillow stack. It does not acquire control, open camera devices, change motor calibration, write deployed configuration, or call inference providers.

The output is evidence for review, not a commissioned robot profile. A plane mapping is not camera intrinsics, a camera-to-base transform, or a depth estimate. The current tool intentionally accepts only the fixed `workspace` camera. A moving wrist camera needs a calibrated pose chain and time-aligned joint observations.

## Collect one reference frame

Keep the workspace camera fixed. Put a flat, measured target on the working plane, with at least six fit points spread across its boundary and at least three separate, non-collinear check points inside that boundary. More points distributed across the region improve the chance of detecting distortion or labelling mistakes. Choose the split before fitting; do not remove inconvenient check points to obtain a passing result.

Save the existing capture tool's JSON response, preserving the original image and frame ID:

```sh
mkdir -p var/calibration
bun run cli capture '{"camera":"workspace"}' > var/calibration/capture.json
uv run robo-calibrate prepare var/calibration/capture.json \
  --setup-id workspace-mount-v1 \
  --coordinate-frame tabletop_board \
  --plane-z-m 0 \
  --output var/calibration/reference
```

Use the coordinator connection already configured for the CLI. `prepare` reads the saved response locally; it does not contact the coordinator. It writes `frame.jpg` (or `frame.png`) and a `measurements.json` template. Blank point coordinates deliberately fail validation until actual measurements replace them.

For each point, supply:

```json
{
  "id": "fit-1",
  "split": "fit",
  "uv": [120, 180],
  "xy_m": [0.02, 0.04]
}
```

These numbers illustrate the format only. `uv` uses original-image pixel coordinates, with the origin at the top left, u increasing right and v increasing down. `xy_m` is the physically measured position in metres in the named coordinate frame. `plane_z_m` is the constant Z in that same frame. A board frame may define its own origin and Z=0; that does **not** establish its position relative to the robot. Name the frame `base_link` only when those points have actually been measured in the commissioned robot base frame.

Pixel labels must refer to the same physical marks as the measured positions. A ruler or printed grid of verified dimensions is sufficient for starting this measurement exercise. Do not infer ground truth from uncommissioned arm kinematics. Preserve the original image: a resize, crop, rotation or re-encoding breaks its identity.

## Fit and review

Choose a maximum error appropriate to the intended task. The 5 mm below is an example, not a claimed accuracy or an approved motion tolerance:

```sh
uv run robo-calibrate fit var/calibration/reference/measurements.json \
  --image var/calibration/reference/frame.jpg \
  --max-error-mm 5 \
  --output var/calibration/fit-v1
```

The new output directory contains:

- `calibration.json`: versioned measurements, image hash/frame ID, camera setup, coordinate frame, plane height, explicit tolerance and content-derived calibration ID.
- `evaluation.json`: the image-to-plane matrix, fit/check RMSE and maximum error in millimetres, and each point's residual. The matrix is derived again from the original fit measurements on subsequent evaluations.
- `overlay.svg`: the original image with cyan fit points and yellow check points. Circles are labelled pixel positions; crosses are the fitted projections of measured plane positions. Connecting segments expose disagreement. This self-contained SVG opens in a browser.

Exit code 0 means all fit and check errors are within the requested tolerance; 1 means outside tolerance and still saves the report/overlay; 2 means invalid inputs or a file error. Existing output directories are refused so a rerun cannot silently replace evidence.

The fitter rejects insufficient, duplicate, collinear or unstable reference layouts. Check points must lie within the region covered by fit points, in both pixels and measured plane coordinates. It uses every fit point: there is no hidden outlier removal. A low training error cannot substitute for held-out validation.

## Evaluate another recorded frame without refitting

Capture/prepare another frame with the **same setup ID, dimensions, coordinate frame and plane height**. Keep the camera fixed and label at least three non-collinear check points within the original reference region. This evaluation's points must all use `"split": "check"`, and their physical positions must not reuse the original fit targets. Original held-out check targets can be observed again to measure drift.

```sh
uv run robo-calibrate evaluate var/calibration/fit-v1/calibration.json \
  var/calibration/recheck/measurements.json \
  --image var/calibration/recheck/frame.jpg \
  --output var/calibration/evaluation-v2
```

This produces a new report and overlay using the original fit; it does not adjust the calibration to hide drift. The original held-out error remains in `reference_check` and must also meet the tolerance: a later passing subset cannot erase a known failure in the reference evidence. Changed setup metadata is rejected. A setup ID is an operator-maintained identity, not an automatic camera-motion detector: change it after moving a mount or changing zoom, focus, crop or image processing, then collect fresh evidence.

## What this establishes, and what comes next

A passing result establishes error at the labelled check points on that plane. It does not establish accuracy everywhere, account for every lens-distortion effect, measure arm repeatability, or authorize Cartesian movement. Object tops above the plane have parallax: do not feed a mug's image centroid through this mapping and assume it is a valid grasp position. Full camera intrinsics/extrinsics or separate measured geometry are needed for elevated targets.

Next steps are to collect physical reference measurements, inspect held-out residuals, and then add calibrated 3D geometry and a supervised tabletop task. Depth-model comparison comes after that: recorded inference outputs need independently measured depth labels, explicit units and provider/model identities. This CLI evaluates planar localization; it does not yet benchmark DA3 or YOLO inference.

The operator's next contribution is a fixed camera and measured reference target, plus the intended task's tolerance. The software work, fitting, reports and regression checks can proceed independently. Provider configuration and a spending limit are needed only when running paid perception, not for this workflow.
