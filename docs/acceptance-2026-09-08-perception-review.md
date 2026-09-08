# Perception overlay and camera recording acceptance

Deployed on 2026-09-08 from `main`: `37ed394` (source frames/history) and `8098e81` (camera review UI). Both `robo-app` and `robo-rerun` are active at the existing private workbench, `http://100.105.51.45:8940`.

## Verified behavior

- Manual perception opens the exact saved camera image with colored segmentation masks, outlines, labels, and opacity controls. Relative depth has a toggle and legend. A separately labeled live inset continues to show current camera images.
- Persistent, paginated history includes agent checks, failures, and legacy results. New agent results do not replace the selected review. Older results without source images remain standalone previews.
- Record/Stop recording is next to the camera and remains available during perception review and inference. Stop offers a direct Review & export entry into the existing editor.
- Recording perception markers retain the session association when inference finishes after Stop. Marker times are relative to recording start; raw training images are not altered.
- Existing preview URLs remain compatible. History, details and source images use the existing authentication boundary and shared Effect Schema contracts.

## Checks

`TMPDIR=$PWD/var/test-tmp bun run check` passed: 125 Bun tests and 82 Python tests, plus formatting, lint, strict type checks, graph and unused-code gates. `bun run build` passed. Existing transitional warnings remain.

New API regression tests cover exact saved-image bytes, matching source-frame IDs, failed requests, legacy previews, pagination without duplicate rows, authentication, invalid cursors and inference finishing after recording stops.

`ROBO_BROWSER_PERCEPTION_ONLY=1 python3 scripts/browser_check.py` passed against a local deterministic perception worker and mock robot. Browser assertions checked mask pixels, source-frame stability through toggles, recording start/stop and markers, persisted history after reload, agent-result isolation, wrist-camera depth, mobile overflow and access to robot Stop. The segmentation screenshot was visually inspected.

Evidence is retained locally in `var/perception-review-acceptance/`: `check.log`, `build.log`, `browser.log`, `segmentation.png`, and `deployed-read-only.json`.

## Deployed checks and remaining verification

Read-only production checks passed: two existing completed perception results are listed and their detail endpoints decode successfully. Both correctly report no saved source image and retain their preview. The real SO-101 has no controller owner or fault, and telemetry is online.

Automatic approval review rejected the proposed two real-camera inference calls because explicit approval is required for the camera-image transfer to fal and paid inference. Neither call ran. The existing budget remained $5 total / $0.10 reserved. New live-provider overlay verification is pending that approval; deterministic overlay/UI verification is complete. No robot motion was submitted during this work.
