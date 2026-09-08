# Perception and recording acceptance — 2026-09-08

Deployed from `main` through `02de507` to the existing private workbench at `http://100.105.51.45:8940`. `robo-app` and `robo-rerun` were rebuilt/restarted and are active. The Python motor service was not restarted; no motion was submitted during acceptance.

## Model configuration

The operator-authorized existing fal credential was installed in the service environment outside the repository, with mode 0600. Runtime status confirms both fixed adapters are configured:

- SAM 3: `fal-ai/sam-3/image`, for text-prompted masks and pixel bounds.
- Depth Anything V2: `fal-ai/image-preprocessors/depth-anything/v2`, for relative-depth previews.

The existing Qwen3.8-max model remains the reasoning/image-review model. SmolVLA is the proposed first training policy; no policy training or deployment occurred. The CPU export environment is installed using the versions in `config/export-requirements.txt`.

The aggregate perception budget is absent. Both capabilities accurately report `configured: true`, `ready: false`, with a prompt to approve a budget in Activity. No paid fal calls or camera transfers to fal occurred. Authentication/inference at the hosted provider is therefore still unverified. The $0.05 setting reserves a conservative amount per request; it is not a quoted price or an approved aggregate cap.

## Verification

- `TMPDIR=$PWD/var/test-tmp bun run check`: passed, including formatting, lint, strict types, package graph, unused-code checks, 118 Bun tests and 81 Python tests.
- `bun run build`: passed. Existing transitional lint, optional Python import, deprecation and terminal chunk-size warnings remain.
- Expect browser acceptance against an isolated mock server: start/stop recording, review camera frames, task/outcome/intervention inputs, MP4 download, native LeRobot ZIP download, mobile overflow and Stop visibility. Passed after correcting accessible select labels.
- Native ZIP loaded through LeRobot 0.6.0's actual `LeRobotDataset` reader in offline mode. Source-frame mapping count matches dataset length.
- A sub-frame-duration interval is rejected if resampling leaves fewer than two frames. An intentionally disrupted event writer makes capture incomplete; incomplete or poorly aligned recordings cannot become training episodes.
- Steering tests reject stale model tools and a motion whose instruction changes during acquisition. Agent observations are fetched directly and retain the 250 ms transport-inclusive freshness bound.

Early integration runs exposed host-load timing failures, including cascading failures after an idempotency assertion. The isolated test browser was consuming multiple CPU cores and was shut down after browser acceptance. The final complete gate passed; lease, freshness and motion limits were not relaxed.

Local evidence is retained under `var/recording-acceptance/`: the browser screenshot/log, full check/build logs, mock dataset and reader result, and the real-camera artifacts below. These local artifacts are not committed.

## Real-camera acceptance

Recording `e125caef-7d0e-41f4-a19c-820be2af26bf`, labeled **Recording acceptance: stationary real SO-101**:

- State `captured`, 31 original samples over 2.999926 seconds.
- Largest camera/state skew 142.675 ms; the whole interval passes the 150 ms export gate.
- MP4: 30 decoded frames at 10 Hz, 1280 × 576, both cameras and measurement overlay.
- Native LeRobot: 30 frames at 10 Hz; measured state and commanded action shapes `[6]`; both decoded camera tensors `[3, 480, 640]`. First and last dataset frames were read successfully. All 30 exported frames map to recorded source indices.
- Outcome stays **unreviewed**: this is an export acceptance sample, not a successful manipulation demonstration.
- Operation ID unchanged before/after capture, no controller owner, no fault; telemetry online after promotion.

[Download the MP4](http://100.105.51.45:8940/api/recordings/e125caef-7d0e-41f4-a19c-820be2af26bf/exports/8392105b-0bb9-4462-9dc6-79233ea87153/clip.mp4) or [the native dataset](http://100.105.51.45:8940/api/recordings/e125caef-7d0e-41f4-a19c-820be2af26bf/exports/893ca81e-9f31-4cbd-aa03-90861d532565/dataset.zip) through the existing authenticated private workbench. Source captures remain preserved.

Paid inference still needs an operator-approved spending cap, as required by `AGENTS.md`. Automatic picking additionally needs commissioned geometry/Cartesian control; a segmentation mask or relative-depth preview does not supply that commissioning.
