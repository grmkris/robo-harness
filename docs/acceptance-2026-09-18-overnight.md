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
