# Perception backends

The coordinator sends a specific camera frame to an authenticated worker. The worker responds with the same frame_id, kind, model/version, width/height, a base64 PNG preview, and optional masks or depth values. Coordinates refer to the source image; depth has an explicit units field.

The first-party worker exposes POST /infer and supports:

- SAM 3 text-prompt segmentation, via the official sam3 package.
- Depth Anything 3 via its official depth_anything_3 package. Output is labeled relative; it is not a range sensor.

Set SAM3_CHECKPOINT to a pre-downloaded checkpoint file and DA3_CHECKPOINT to a versioned model directory. Request checkpoint access where required, pin the upstream revisions when building the worker, and record them alongside the model weights. The CPU-only hosts do not load these models.

Run on a GPU host, including a RunPod pod:

```sh
robo-perception --host YOUR_PRIVATE_INTERFACE --port 8790
```

Set ROBO_PERCEPTION_TOKEN on the worker and the matching value on the coordinator. Set ROBO_PERCEPTION_URL to the reachable private endpoint. Keep workers off the motor path.

For fal, configure ROBO_FAL_ENDPOINT as an endpoint implementing this contract (for example, a hosted wrapper around the same model code). Arbitrary catalog endpoints have different input/output shapes and require a matching adapter; the app does not silently guess their schemas. The fal queue adapter validates returned job URLs, polls boundedly, and requests cancellation on timeout.

ROBO_PERCEPTION_COST_USD must be a conservative maximum per inference request. The operator approves an aggregate limit in Activity. Each request reserves that amount atomically before submission, including requests whose billing outcome becomes uncertain. A request rejected before submission or with an explicit client-rejection response can refund the reservation. Lost responses, timeouts, and server errors retain it because the provider may already have accepted or executed the work. The failure event records `reservation_retained`. The UI calls it reserved spending; reconcile with provider billing before adjusting estimates.

The app does not create persistent GPU pods automatically. Operator-provisioned pods remain the operator's responsibility to stop. RunPod serverless jobs can use the same worker contract through a deployment wrapper.

Model inference, licensed checkpoint access, hosted endpoints, and paid billing have not been exercised without configured credentials/GPU hardware. Unit tests can validate contracts without representing synthetic output as model inference.

For a fixed-camera baseline with measured ground truth, use the [offline tabletop calibration workflow](tabletop-calibration.md). It produces image overlays and held-out error reports without running a perception model.

## Catalog fal adapters

`ROBO_FAL_SEGMENT_ENDPOINT=fal-ai/sam-3/image` selects SAM 3. `ROBO_FAL_DEPTH_ENDPOINT=fal-ai/image-preprocessors/depth-anything/v2` selects a Depth Anything V2 relative-depth preview. Both use `FAL_KEY` in the coordinator service configuration. These are fixed adapters with validated output, not arbitrary interchangeable model names. Per-capability status explains missing configuration or budget before the UI offers a request.

SAM 3 masks retain source-frame geometry and include pixel area/bounds. Depth previews carry their actual dimensions and a scale back to source pixels; no numeric metric depth is claimed. Hosted model revisions are labeled unpinned. The original private worker and custom endpoint contracts remain available.

The deployed conservative reservation is $0.05 per request. This is a budget reservation ceiling, not a quoted model price. Approve the total cap in Activity before sending any paid request. The provider receives the chosen camera image and prompt; recordings and exports do not require this transfer.

## Camera review and history

Each submitted check saves its exact source image before inference. The camera panel opens manual results on that historical frame, with a separate live inset. Segmentation has colored masks, outlines and opacity controls; relative depth has an overlay toggle and legend. New agent checks appear in the history strip without replacing the operator's selection. Camera-side recording captures both cameras and telemetry, and remains stoppable during inference.

`GET /api/perception` returns 25 newest checks and a `next` cursor; pass `before` for older checks or `recording_id` for recorded-session markers. `GET /api/perception/:id/detail` returns validated metadata and result, and `/source` returns the saved image. The existing `/api/perception/:id` preview remains available. These routes use the existing authentication boundary.

The recording association is fixed from the source capture when a request begins, so a late result remains visible from its original session. Marker times are relative to recording start. Results predating source-image preservation remain standalone previews. An interrupted running check becomes a visible failure after restart; uncertain spend reservations remain retained. Browsing or reopening results never submits inference or modifies raw training images.
