# Benchmark fixture and evidence

The general chat tools and SO-101 skills are shared by all models. Task-specific scheduling, reset decisions and scoring live outside that prompt and tool surface.

`bun run bench --count=6` prints a seeded schedule. It performs no network request or motion. It refuses an uncommissioned manipulation config, missing geometry, more than 32 targets, targets closer than 3 cm, or an area too small for the requested count. The current lab profile is deliberately uncommissioned. Opus is excluded from the primary rotation; the overnight handoff caps it at two later trials.

A live trial runner is not wired up yet. The fixture reset loop (`apps/server/src/bench-reset.ts`) is implemented and tested, but its adapter is not connected to live hardware. It reobserves an unknown position and pauses after three failed attempts. The physical admission gates remain a measured TCP/home/safe polygon, a held-out homography error within about 1 cm, three reset pick-and-places and one watched trial per model. Offline tests do not satisfy those gates. The reset adapter must use the shared supervised executor, stop on the first unknown/failed motion, and independently verify contact, lift and final placement before another attempt.

## Read-only evidence capture

Set `ROBO_URL` to the coordinator and, in token mode, `ROBO_TOKEN` to the operator credential. The CLI holds no motor or provider credential.

```sh
bun run bench:capture --out var/bench/2026-09-23/safety-check-01
```

The output directory must be new. The collector saves the original workspace and wrist JPEGs, capture IDs/times, paired observations and SHA-256 hashes. It rejects stale frames, wrong camera roles and robot clock changes. An observation HTTP 503 gets at most four read-only retries; retry counts are recorded and freshness thresholds are unchanged. Other failures leave an incomplete manifest. Existing evidence is never overwritten. Room images remain in ignored local `var/`.

## Offline judge replay

`bun run bench:judge path/to/replay.json` makes no network/provider request and cannot move the robot. Paths in its manifest resolve relative to the manifest. The config must be the snapshot used for the recorded trial, not a later edited calibration. For example, an **offline, unverified** replay manifest is:

```json
{
  "kind": "offline_fixture",
  "config": "manipulation-snapshot.json",
  "before": "before/workspace.json",
  "after": "after/workspace.json",
  "lift_workspace": null,
  "lift_wrist": null,
  "target_xy_m": [0.12, 0],
  "gripper_stalled_at": null,
  "claimed_success": false,
  "failure_hint": null,
  "sam": null,
  "vlm": null
}
```

Replay verifies the JPEG hashes, camera roles, freshness at original capture, shared clock, and before/lift/after order. Wrist evidence cannot establish table position. Final position uses the lower edge of a single accepted workspace CC box and is labelled as a table-plane estimate with parallax uncertainty; it is null when the config is uncommissioned or there is no unique candidate.

Pickup needs mechanical resistance above 8%, CC movement and jaw evidence, and a SAM check. External verification records have `value` (boolean or null), `frame_ids`, and `method`. A SAM record must reference the before-workspace, lift-workspace and lift-wrist IDs; a VLM record references before and after. A missing or mismatched record stays null. The replay preserves VLM disagreements and supplied source records for review; it does not call those providers or certify their annotations. Obtain `gripper_stalled_at` from the saved gripper tool result during the lift phase, never from a model's success claim.

Keep smoke/reset/fixture results distinct from scored trials. A replay output is an interpretation of supplied evidence, not proof of commissioning or live trial admission.

## Trial caps

`bun run chat --wall-ms 300000 ...` passes a coordinator-enforced wall-clock cap (1 second–30 minutes). Expiry aborts the turn and its supervised motion even if the client disappears. The headless client drains cancellation for at most five seconds; without its matching `chat.finished`, the outcome is unverified and must not be submitted again automatically. Steps and provider-stream stall limits remain bounded separately.
