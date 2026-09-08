# Chat action upgrade acceptance — 2026-09-08

Implementation: `d4b43bf` (schemas), `d18042b` (model capabilities and feedback), `7d89bfc` (supervised actions). Architecture: [decision 0004](decisions/0004-supervised-chat-motion.md).

## Automated and browser checks

- `bun run check` passed: format, lint, typecheck, import graph, type-aware lint, unused-code checks, 85 Bun tests, Python lint/format/typecheck, and 53 Python tests. Existing transitional lint warnings, ten optional Python import warnings and two dependency deprecations remain.
- The focused chat integration suite also passed after adding turn metrics: six scenarios cover delayed reasoning, same-response mutation admission, strict numeric input recovery, cancellation, human takeover, and hidden tool/image handling.
- `bun run build` passed.
- `scripts/browser_check.py` ran with `ROBO_BROWSER_CHAT_ONLY=1` against a port-zero `startHarness` mock with scripted provider responses: quoted duration, corrected numeric duration, final summary. The model picker switched between an image-enabled fixture and a text-only model; validation errors stayed visible, progress was coalesced, completion was measured, ownership was released, and mobile layout/Stop remained usable. Screenshot: `/tmp/expect-artifacts/screenshot-1788846019688.png`. The final build darkens the image-capability text for readability.

The delayed live coordinator fixture waits 3.5 seconds between observation and the motion request. Executor unit tests also advance the pre-action clock by 1, 5, 15 and 30 seconds; these are simulated delays, not four paid model runs. Fault tests cover uncertain submission, pending journal recovery, cancellation during acquire/submit, renewal failure, timeout, takeover and no replay after restart.

## Deployment and local hardware

Promoted the tested Python `engine.py` and `service.py` to the Pi, then restarted `robo-io`, `robo-app` and `robo-rerun`. All three units are active. The previous Pi engine lacked the already committed final-deadline check; promotion includes that tested fix. Backups are on the Pi at `var/chat-upgrade-20260908/*.before`. No deployment credentials/configuration, calibration, commissioned limits or lease TTL were changed.

The deployed observation exposes `control_epoch`; the arm is fault-free. The configured Qwen3.8-Max now reports documented direct-image support without an environment change.

The existing local-only `scripts/real-arm-smoke.ts --move` passed against the deployed app:

- Gripper request: 8.3333% to 10.3333% over 1.5 seconds; settled measured change +1.775956 percentage points.
- Operation `12323cb1-05bf-47a7-bc71-bdd01492becf` reached measured completion. Terminal evidence includes the measured pose and residual; all five other arm joints stayed unchanged.
- Stop revoked ownership and preserved the commanded hold. No fault was reported.
- Fresh camera frames, local recording, and a 4,886,064-byte Rerun replay passed.
- Evidence: `var/real-arm-acceptance/motion.json`. Previous evidence was preserved under `var/real-arm-acceptance/before-chat-upgrade/`.

This hardware test uses the low-level MCP client. The supervised chat lifecycle is validated by the mock integration suite; it has not yet been accepted against a live model controlling the real arm.

## Remaining endpoint check

Automatic approval review rejected the proposed live Qwen camera-and-motion acceptance because sending a workspace frame to Alibaba requires explicit image-egress authorization. That command did not run, and no frame was sent to Alibaba by this acceptance work. The pending check is one workspace image through the configured Qwen3.8-Max endpoint, one gripper-opening action bounded to two percentage points, and verification of the measured terminal result. It requires the operator's approval for the image transfer. This is separate from the already authorized and completed local deployment and hardware checks.
