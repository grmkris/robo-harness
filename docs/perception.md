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

ROBO_PERCEPTION_COST_USD must be a conservative maximum per inference request. The operator approves an aggregate limit in Activity. Each request reserves that amount atomically before submission, including requests whose billing outcome becomes uncertain. The UI calls it reserved spending; reconcile with provider billing before adjusting estimates.

The app does not create persistent GPU pods automatically. Operator-provisioned pods remain the operator's responsibility to stop. RunPod serverless jobs can use the same worker contract through a deployment wrapper.

Model inference, licensed checkpoint access, hosted endpoints, and paid billing have not been exercised without configured credentials/GPU hardware. Unit tests can validate contracts without representing synthetic output as model inference.
