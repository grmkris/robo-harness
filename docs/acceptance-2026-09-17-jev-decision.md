# Acceptance — Jev decision runner on the real arm (2026-09-17)

Operator present at the arm for every motion block and gave an explicit "go". Real SO-101 follower on lab-pi, lerobot 0.6.0, `ai@7.0.105`, model `typesafe-ai/jev` on Vercel AI Gateway (paid credits, zero data retention off). Run logs: `~/.local/state/robo-harness/decision-runs/<run>.jsonl`.

## Gateway access

- The first live smoke failed on billing ("valid credit card on file"). A card, then a paid top-up, were needed: free credits do not cover Jev ("Free tier users do not have access to this model"). Zero data retention is refused on the Hobby plan and is now opt-in (`ROBO_JEV_ZDR=1`). All three refusals were classified as `billing`.
- Passing smoke: static fixture → `reobserve`, p=0.97, 479 ms, 352 input / 37 output tokens, $0.0000148.
- Jev cannot go through cliproxy: the AI SDK posts to Gateway's own `/v4/ai/evaluation-model` protocol.

## Offline fixtures with live Jev (11 fixtures, no robot)

| Strategy | Acceptable | Misses | Latency p50 / p95 |
| --- | --- | --- | --- |
| C critic | 11/11 | — | ≈ 300 ms |
| A choice | 10/11 | retried a pan step right after it failed | 306 / 707 ms |
| B parallel | 8/11 | `stop` instead of reobserve/wait on stale data and motion in progress; retried a failed step | 272 / 338 ms |

The rules baseline and the SDK mock pass 11/11 for every strategy.

## Read-only on the real arm

- Observation age seen by the runner from netcup: 176 ms p50, 223 ms p95, 1.2 % above 250 ms (Pi-side age 17 ms p50; HTTP round trip 158 ms p50). No freshness-gate change needed; only the cached `/api/tool/observe` path hits the 250 ms gate.
- Dry-runs A/B/C: 0 motor writes. The first dry-runs exposed a bug: full 2 % gripper steps were refused locally because ~0.1 of sensor jitter pushed them past the exact step/speed limit the motor owner also enforces. Candidates now keep 0.2 headroom and plan duration at 90 % of the speed cap.

## Joint baseline (P=16, forward-leaning pose)

≤1.8° out-and-back per joint through the runner, rules baseline:

- gripper 1.23 / 0.96, wrist_roll 1.06–1.67, wrist_flex 1.50 / 0.88, elbow_flex 1.23 then two of three failed (0.70–0.79)
- shoulder_lift 0.26, shoulder_pan 0.09–0.26 (failed to settle)

A second live bug: goals like `wrist_roll=-8.48` were parsed as relative, so a "return" moved another −8.5° (away from the table, no contact). Goals are now `joint+=N` / `joint-=N` relative and `joint=N` absolute.

## Diagnosis and fix

`scripts/servo_step_trace.py` showed LeRobot's P=16 dead band (details in [the incident resolution](incident-2026-09-09-pickup.md#resolution--2026-09-17)): wrist_flex against gravity moved 0.00° at P=16 and 1.41° at P=32; supply 5.3 V at rest, 4.7 V under load. The lab-pi profile sets `p_coefficients` 32 on the arm joints, 16 on the gripper.

## Control smoke (gripper +4 %, wrist_flex +2°, back; upright neutral pose)

| Decider | P=16 | P=32 |
| --- | --- | --- |
| rules | 4 completed, then 2 wrist failures → `repeated_failures` | **done**, 4/4, 8.6 s |
| Jev choice | 3 completed (1 refused: observation 525 ms old), 2 failures | **done**, 5/5, 14.2 s, $0.00028 |
| Jev critic | 4 completed, 2 failures | **done**, 5 completed + 1 failed (residual 0.92°) → reobserve → corrective step → done, 17.2 s, $0.00028 |

No faults latched. Total Jev spend for the day ≈ $0.003.

## Hardware notes

- A follower USB board stopped enumerating after the arm power was pulled (`device not accepting address … error -22`); only a full power cycle of the Pi and both arms recovered it.
- Startup refuses a joint left past its calibration range (elbow 0.6° past its maximum after a hand reposition); move it inward by hand with torque off.
