# Perception and recording derivatives

Accepted 2026-09-08. The operator requested model choices, activation with the existing fal credential, recording exports, and the related steering improvements.

## Model roles

- **SAM 3** through `fal-ai/sam-3/image`: text-prompted image masks. A fixed adapter supplies PNG masks, source-frame identity, pixel bounds and area. Empty detection is a valid result. Hosted model revisions are reported as unpinned, never invented.
- **Depth Anything V2** through `fal-ai/image-preprocessors/depth-anything/v2`: relative-depth preview with explicit scaling to the source image. This is not the first-party DA3 worker and is not a metric range sensor.
- **Qwen3.8-max**, already configured with image input: task discussion and review of selected live or archived frames. Captures from recordings are labeled historical. A completed joint operation is not evidence of a successful grasp.
- **SmolVLA** is the proposed first learned policy after reviewed demonstrations exist. No training or autonomous policy deployment is implied by installing a dataset exporter.
- Video rendering, trimming and dataset conversion use deterministic local code: Pillow, PyAV/H.264 and LeRobot 0.6.0. No generative-video model changes experiment evidence.

Sources: [fal SAM 3](https://fal.ai/models/fal-ai/sam-3/image/api), [fal depth V2](https://fal.ai/models/fal-ai/image-preprocessors/depth-anything/v2/api), [SmolVLA](https://huggingface.co/docs/lerobot/smolvla), [LeRobot v3](https://huggingface.co/docs/lerobot/lerobot-dataset-v3).

## Ownership and limits

Effect owns one fal submission, deadline, polling and cancellation. Definite submission rejection refunds the reservation; uncertain billing retains it. Effect Schema validates returned envelopes. Media decoding checks size and geometry, and the fal credential is sent only to the queue API. Model media URLs cannot redirect requests or address private hosts. A per-request conservative reservation and an explicitly approved aggregate budget are independent requirements.

Each operator steer advances a revision. A stale model response cannot execute its queued tool, and motion checks the revision again after observation and acquisition. Already submitted bounded motion retains its existing supervision and measured-result semantics. Stop continues to revoke control immediately.

Recording remains at 10 Hz. Version 2 stores observation monotonic time independently from filesystem latency and records camera/state skew. Disk writes do not block observation polling. The bounded event writer drains before atomic manifest finalization. Write failures, dropped sample deadlines and restart remain visible as incomplete capture.

The recording library exposes inspection, archived-frame selection and interval exports to both the workbench and agent tools. Derivatives preserve their source recording and carry task, outcome, intervention and source-index provenance. Sharing exports can use speed changes and measurement overlays. Training exports retain both original camera views and original time, reject incomplete recordings, reject gaps over 250 ms, and require camera/state skew at most 150 ms. That threshold is an export quality gate, not a claim of hardware synchronization accuracy.

Export processes receive no provider/hardware credentials and use offline Hub mode. An Effect scope owns the process group, 120-second deadline, cancellation and shutdown. Only one export runs at once, and intervals are bounded to five minutes. Completed artifacts are downloadable through authenticated routes; neither datasets nor clips upload automatically.

The native dataset's action column is sampled commanded joint positions in degrees and gripper percent. It is not a measured applied-action log. A future deployed policy needs an explicit representation adapter and must feed the existing Python motor owner. Stock LeRobot hardware-recording commands must not open a second motor connection.

## Remaining physical work

Segmentation does not commission Cartesian motion. Camera/robot calibration and measured task geometry remain separate prerequisites for automatic picking. Training also requires reviewed demonstrations; a recording feature is not a trained policy.
