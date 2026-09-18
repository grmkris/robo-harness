# Acceptance — overnight free-rein programme (2026-09-18)

Kris granted free rein on the arm and cameras overnight, lights on, mat clear except the white piece, P ceiling 128 trace-gated, up to ~6 recorded pickup attempts with the piece placed back after a success. Standing rules and phases: the plan file of the session; results here. Run logs in `~/.local/state/robo-harness/decision-runs/`, recordings in the workbench.

## Phase A — the arm climbs now (gain sweep)

`scripts/servo_step_trace.py` (now with `Present_Temperature` and a rest-jitter sample per P) in the forward-leaning hover pose the pickup runs from:

| Joint | Step | P | Travelled | Residual | Peak current | Rest jitter |
| --- | --- | --- | --- | --- | --- | --- |
| shoulder_lift (raising) | −1.8° | 48 | −0.61° | 1.19° | 208 mA | 0.0° |
|  |  | 64 | −1.32° | 0.74° | 260 mA | 0.0° |
|  |  | **96** | **−1.85°** | **0.30°** | 403 mA | 0.0° |
|  |  | 128 | −1.76° | 0.30° | 566 mA | 0.0° |
| elbow_flex | +1.8° | 64 | 1.85° | 0.05° | 130 mA | 0.0° |
|  |  | 96 | 1.50° | 0.04° | 150 mA | 0.0° |
| wrist_flex | +1.8° / back | 32 | 1.76° / −0.97° | 0.04° / 0.79° | 65 mA | 0.0° |
|  |  | **64** | 1.41° / −1.67° | 0.13° / 0.26° | 228 mA | 0.0° |
| shoulder_pan | +1.8° / back | 32 | 1.41° / −1.05° | 0.39° / 0.35° | 65 mA | 0.0° |
|  |  | **64** | 1.67° / −1.76° | 0.05° / 0.09° | 188 mA | 0.0° |

Servos at most 41 °C. Profile: **pan 64, lift 96, elbow 96, wrist_flex 64, roll 32, gripper 16** (elbow went 64 → 96 after it lagged a degree once the arm was 8 cm up). The driver's ceiling moved from 64 to 128 to match.

**Gate A passed:** control smoke `done` 5/5; the climb that failed 17/17 moves last night completed 14/14 and took the tip from 3.5 cm to 7.9 cm; a later run reached 9.2 cm at r = 0.19 m.

## What the first three runs of the night found (each fixed, each verified)

1. **`moveTip` walked one solve in joint space and never checked where the tip ended up.** It now solves and walks waypoints ≤ 3 cm apart, re-solving from the measured pose, and judges itself on the tip's final position. The search also goes to its start (scan height, r ≥ 0.20 m) first.
2. **The wrist Innomaker drops off the bus under arm motion** and comes back re-enumerated (`/dev/cam_wrist` → a new `videoN`); the old handle then reads nothing forever and the motor owner's freshness guard refuses every move. It ended the 09-17 recording and refused all 312 moves of run #2 tonight. `lab_cameras` now reopens a device that has delivered nothing for 2 s (verified against a fake device; the second reopen after a re-enumeration is the one that works, as on the real camera).
3. **The first real sighting was a wedge of white table at the mat edge**, under the 80 % background rule, and the arm swung over to centre on it. A bright region that touches the frame edge or covers > 12 % of it is now background; a real piece between the jaws (0.7 % of the frame, recording 628373f2 — with a cat inspecting it) still detects.
4. **The arm sank during pan sweeps although every move completed.** The motor owner started every operation from the _measured_ pose, so a pan-only move re-commanded the other joints to wherever gravity had let them settle; a few tenths of a degree per move ratcheted the lift's command from −16° to −7° over thirty moves and the tip from 9 cm to 5 cm (recording of run #4). `submit` now holds the _commanded_ position for joints a target does not mention, as `stop` already did.
5. The search arcs were centred on whatever heading the arm was left at; they centre on the mat now and regain height before each arc.

Also landed: `joint_health` in the scene (per joint follows / lag / stalled direction; the rules stop instead of retrying a skill that stalled on a joint that no longer follows), a wall-clock deadline inside skills, a `place` skill with `--place-back`, leader-mode mock tests, and `scripts/overhead_calibration.py` (refuses tonight's sweeps honestly: black arm on black mat gives too few clean tip detections; the piece detector finds the piece at (176, 329) once restricted to the mat).

## The run-by-run ledger

Each attempt died of something different, and each cause was real. In order:

| # | Ended with | Cause, once read against FK and the recording |
| --- | --- | --- |
| 1 | swept 3 arcs, piece unseen | `moveTip` walked one solve in joint space: the "7 cm outward" step lost 6 cm of height and the sweep ran at the mat edge |
| 2 | 312 moves, all refused | the wrist camera had re-enumerated; the motor owner's freshness guard refused every acquire (correct) |
| 3 | centred on nothing | a wedge of white table at the mat edge passed the background rule and the arm went to centre on it |
| 4 | swept, piece unseen | arcs centred on the heading the arm was left at, and the arm sank 4 cm over thirty "completed" moves |
| 5 | `Camera observation is stale` at 509 s | a sub-second camera hiccup crossed the 500 ms guard and the runner treated the cancelled move as fatal |
| 6 | `Target did not settle` after 18 moves | holding the command for unmentioned joints was right, but the completion check still judged them, and a loaded joint sits ~1.3° below its command |

Nothing in that list is the tactician, the model, or the plan. Every one is a plumbing fact that only shows up when the recording is read against forward kinematics — a completed move that moved the arm somewhere else, a camera that is alive but stale, a verdict about a joint nobody asked to move.

The gate found one more: the repo's own test asserting "a live smoke without a key is blocked" inherited this host's real `AI_GATEWAY_API_KEY` through the spawned app, so it made a **billed** Gateway call and then failed on the answer being "passed". The harness now gives the app no ambient credential.

## The reach cap, and why it is a torque number

Attempt #7 failed every move with `shoulder_lift` 1.2–1.4° short while the arm was fully extended at r ≈ 0.27 m. The P sweep that set P=96 was traced in the _hover_ pose (r ≈ 0.15 m) — a far shorter lever. Re-traced in the extended pose:

| P | Raising 1.8° | Residual | Peak current | Servo temperature |
| --- | --- | --- | --- | --- |
| 96 | −0.53° | 1.27° | 604 mA | 52 °C |
| 128 | −2.20° | 0.48° | **1502 mA** | **88 °C** — trace stopped by its own guard |

So P=128 does move it, by heating the servo 36 °C in one 2.5 s step. That is not a gain to ship. The tip is capped at **0.24 m** instead, the search runs its first arc there and steps _inward_, and a piece further out is reported as out of reach. (The spike was transient: the joint was back to 51 °C a minute later, torque on, status clean.)

This also explains the 09-17 "the piece is within the envelope" note. It is, kinematically — the model solves top-down poses to 0.35 m. It is not within the _torque_ envelope, and nothing in the model or the solver knew that. **Trace a joint in the pose that loads it, and cap the workspace by what the trace says, not by what the solver will return.**

## What a run may not die of

Three of the night's runs ended on the motor owner's own protective stops — a camera frame past its 500 ms guard, and its 30 Hz loop overrunning on a throttled Pi. Both reflexes are right: an agent must not move blind or on stale state, and the lease is dropped with the motion. But they are transient, and treating them as fatal threw away a nine-minute search after 163 moves and a three-minute one after 57, in both cases while the arm was doing exactly what it should.

Either message now waits for the robot to be fit again — no fault, fresh observation, fresh cameras — and retries the same step, six times per run, after which the run really does end. Every other cancellation stays fatal, and nothing about the motor owner's behaviour changed: the guard still stops the arm, the runner just no longer treats a pause as a verdict.

## The gain, settled at two radii

P=96 was traced in the hover pose (r ≈ 0.15 m). At working reach with the forearm extended it still left the lift 0.8–1.2° under command on live multi-joint moves — over the motor owner's 0.8° verdict, though the tip was within millimetres, because the sag is systematic. Traced again in that pose:

| P   | Raising 1.8° | Residual | Peak current | Servo temperature |
| --- | ------------ | -------- | ------------ | ----------------- |
| 96  | −1.23°       | 0.57°    | 559 mA       | 51 °C             |
| 128 | −1.93°       | 0.39°    | 949 mA       | 51 °C, flat       |

So `shoulder_lift` is **128**. The 1.5 A / 88 °C spike that stopped the earlier trace was at full extension (r ≈ 0.27 m), which the 0.22 m reach cap now refuses — the same gain is safe inside the envelope and dangerous outside it, which is the argument for capping the envelope rather than the gain.

First transit after the change: **8 of 8 multi-joint moves completed**, lift residuals 0.63–0.72°, where every one of them had failed before.
