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

This first hardware test used the low-level MCP client. The subsequent approved live Qwen test below also accepted the supervised chat lifecycle on the real arm.

## Approved live Qwen acceptance — passed

The operator explicitly approved the camera transfer and bounded movement after automatic approval review initially required that confirmation. The test then ran through the deployed chat service with the configured Alibaba Token Plan account and `qwen3.8-max`; no provider credentials were imported into the development shell.

Conversation: `99eae639-cb50-4de2-988c-19f46b0b5cd2`. Run: `910311c1-bacf-45ac-a589-cbd9f93c5475`.

- Completed in 30.203 seconds over four model steps, with exactly three tool calls: `observe`, `capture`, `move_joints`. No model-managed acquisition or renewal calls.
- The single workspace image was 640×480, reported 31.0 ms old, with a matching robot boot/clock domain. Qwen identified a translucent bin on a black mat and the black robot arm on a white tabletop. Those features match an independently inspected local comparison frame captured immediately after the run.
- The move input was `{"target":{"gripper":12.1092},"duration_s":1.5}`. Both motion values were JSON numbers. Zero invalid inputs, zero tool errors, one completed action; the first tool input was valid.
- Gripper measured 10.109290% before the move and 11.816940% at measured completion: +1.707650 percentage points, with 0.292260 percentage points residual to target. The settled post-turn reading was 11.885246%, a +1.775956-point change.
- All five arm joints remained unchanged. Operation `d4d43ca5-113f-47b0-9c83-440baf1b12cd` completed under original request `f8e8077b-e0a7-422f-919c-34fce95c96db`. Control was released, no fault was reported, and no chat remained running.
- Qwen's final response accurately reported the measured position, target residual, unchanged joints and completed status. It did not label acceptance alone as completion.

Evidence: `var/real-arm-acceptance/chat-upgrade.json`; local visual comparison: `var/real-arm-acceptance/chat-upgrade-workspace.jpg`. These runtime artifacts remain local and are not committed. The acceptance report contains only non-secret metadata.

The original failed interaction is now accepted end to end with the real model and real arm. No further implementation change or model replacement was needed for this test. This is one successful bounded scenario; the fault and concurrency cases remain covered by the automated suite.
