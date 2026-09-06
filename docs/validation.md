# Validation — 2026-09-07

## Real hardware

The physical follower, both cameras, Netcup workbench, MCP, development container, and Rerun are connected end to end. See [deployment and measured evidence](real-arm-preflight.md).

The MCP gripper test commanded +2 percentage points, measured +1.775956, completed, and stopped with no active controller. Recording `379fe264-b58d-4c95-8b04-3e00aa5ec94b` contains 46 samples and 92 images with zero missed recording samples. Its 4.6 MB Rerun file passes `rerun rrd verify`; original camera timestamps and clock domains match the real motor observations.

## Automated checks

- 17 Bun tests pass: HTTP control, ownership, bounds, idempotency, measured completion, takeover, lease expiry, recording, perception contracts/budget, a local synthetic model loop with image messages, MCP images, and tokenless Tailscale access.
- 33 Python tests pass: control timing, stop while planning, camera freshness, geometry envelope, recording/dataset resampling, Rerun output, startup goal-before-torque ordering, bounded explicit recovery, lab capture provenance, and camera cleanup on motor startup failure.
- TypeScript typecheck, production build, and Ruff checks pass. The Python test client emits two upstream deprecation warnings.
- These automated tests use isolated mock services and do not touch physical motors or paid inference.

## Browser acceptance

Local Expect checks pass on the actual HTTP Tailscale deployment: no login, real backend and healthy camera/telemetry status, controls disabled without ownership, replay navigation and decoding, return to live, and a container Python command reading real observations. Browser logs reported zero errors; Rerun uses WebGL2 on this HTTP origin.

The real browser wrist-roll jog also passed: +2 degrees commanded, +1.230769 measured at completion, followed by stop. Evidence is saved in `var/real-arm-acceptance/browser-wrist-jog.json`. Long browser action sequences proved unreliable; the final test uses short Expect actions and independently polls the exact new operation ID through HTTP.

The first production check found that `crypto.randomUUID` is unavailable on a plain HTTP tailnet origin. ID generation now uses `crypto.getRandomValues`. Joint targets retain full numeric precision so display rounding cannot exceed a strict per-operation bound.

Earlier mock browser checks also cover jog/stop, missing-perception errors, recording creation, and mobile layout. Browser automation uses deterministic local Expect commands; no external AI browser tester receives lab credentials or images. Its cursor overlay requires bracket-notation selector calls to avoid eagerly resolving controls created by later actions.

## Scope still unverified

Production provider accounts are not configured. The custom model loop was tested against a local compatible model fixture; the real-arm LLM route was exercised through MCP. SAM3/depth inference, camera extrinsics, Cartesian picking, and physical leader-following motion remain uncommissioned. Native LeRobot export was verified with synthetic temporary images on the Pi; the real capture is retained in the raw/Rerun format.
