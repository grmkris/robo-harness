# White-piece approach blocked by weak joint response

Date: 2026-09-09

The operator requested a pickup. During the initial read-only camera inspection, the operator also started a Qwen workbench conversation, `ab662d18-7c2b-4d4e-9c3d-705eb122a608`, first asking to observe the workspace and then to move the gripper toward the white piece. The assistant's separate pickup runner refused to start because that conversation was active. No competing controller or additional motion was started; the assistant monitored the workbench run and independently captured both cameras afterward.

WorkBench run `e06199f1-4d86-452b-a3d1-af52dad8dee4` made three bounded approach/diagnostic probes:

| Joint | Initial | Target | Duration | Measured change | Result |
| --- | --: | --: | --: | --: | --- |
| Shoulder pan | 1.890° | 2.890° | 1.5 s | 0.000° | Failed to settle |
| Shoulder pan | 1.890° | 2.890° | 4 s | 0.000° | Failed to settle |
| Shoulder lift | 12.879° | 13.880° | 4 s | +0.088° | Failed to settle |

The run ended after nine model steps, eight tool calls, and zero completed actions. All three outcomes were known failures. Final shoulder-lift feedback was 12.967° with a 0.913° residual; final shoulder-pan feedback remained 1.890°. Wrist roll changed by one encoder tick from −2.418° to −2.505° during the first probe. The gripper was not opened or brought around the object, and no lift or grasp was attempted.

Independent before/after camera inspection showed the white piece remaining on the mat and the gripper separate from it, with no meaningful approach. After-camera frames were workspace sequence 113854 and wrist sequence 113880, both from motor boot `65fe5549-f59b-412c-a931-a9659f463aa8`, about 42 and 53 ms old. The final state had no running conversation, no control owner, and no reported fault. The commanded pose was held with torque behavior unchanged.

This does not establish whether the cause is power, small-command response under load, servo configuration, command delivery, or mechanical resistance. A timeout is not proof of a seized motor; a successful prior wrist probe is not proof that every joint can move. No raw torque, goal, current, voltage, or servo-error registers were inspected during this attempt. Qwen's stronger diagnostic exclusions and its quantitative visual claims are not independently established by this run.

No configuration, gains, calibration, motion bounds, or motor code was changed. Further pickup work requires diagnosing the poor joint response. Evidence is preserved in `var/pickup-attempt-2026-09-09/`: initial/final status, workbench transcript, saved conversation captures, and independent before/after JPEGs.

## Requested retry and exclusive servo readback

The operator requested one more attempt and asked how to debug a repeat failure. Conversation `e7664870-490d-457c-a1ef-ce4f7accc4ca` made exactly one shoulder-pan diagnostic move, preceded and followed by both camera captures and measured observations. It requested 1.800° over 2 seconds, within the existing 2° step bound. Operation `84148c5b-f480-452e-ac4a-63ec97d8a0da` / request `523c8be9-e73c-431d-b8a7-3f6ecec3aa35` failed to settle:

| Joint         |     Before |     Target |      After | Measured change |
| ------------- | ---------: | ---------: | ---------: | --------------: |
| Shoulder pan  |  1.890110° |  3.690110° |  2.241758° |      +0.351648° |
| Shoulder lift | 12.967033° | 12.967033° | 12.791209° |      −0.175824° |

All other measured joints were unchanged. The pan residual was 1.448352°, exceeding the 0.8° completion tolerance. Partial movement establishes that this joint was not completely unresponsive in this probe. Independent inspection of the four saved captures showed the piece still on the mat and no meaningful approach or grasp; the camera views do not establish the cause of the poor response.

After the conversation finished and control was unowned, `robo-io` was stopped. A read-only inspection checked that the service was inactive and the serial port unused, then acquired the same exclusive follower lock before connecting to the motor bus. It used `bus.connect()`, not the robot initialization/configuration path, read the registers, and disconnected with torque preserved. The normal motor service was then restarted in a `finally` block. No second motor owner ran concurrently, and the inspection did not write goals, gains, torque, or calibration.

The following values were read **before restart could replace the old goals**:

| Servo register | Shoulder pan | Shoulder lift | Interpretation |
| --- | --: | --: | --- |
| Goal position, raw | 2125 | 2136 | Servo received the requested target, rounded by the installed conversion |
| Present position, raw | 2109 | 2134 | Pan remained 16 encoder ticks short |
| Torque enabled | 1 | 1 | Torque was enabled at inspection |
| Operating mode | 0 | 0 | Position mode |
| Status | 0 | 0 | No reported servo fault at inspection |
| Moving / present velocity | 0 / 0 | 0 / 0 | Both stationary at inspection |
| Present voltage, raw | 54 | 54 | Static reading; no voltage trace during motion |
| Present current / load, raw | 3 / −76 | 0 / −20 | Raw values, not converted into force or amperes |
| CW / CCW dead zone | 1 / 1 | 1 / 1 | Configured dead zone is smaller than the pan residual |
| P / I / D | 16 / 0 / 32 | 16 / 0 / 32 | Existing settings, unchanged |
| Minimum startup force | 16 | 16 | Existing setting, unchanged |
| Torque limit / maximum | 1000 / 1000 | 1000 / 1000 | Nonzero existing limits |

The pan conversion is `int(3.69010989 × 4095 / 360 + (811 + 3356) / 2) = 2125`, exactly the raw goal read from the servo. The raw goal-to-position gap is 16 ticks, or 1.406593°; the slightly larger API residual includes goal quantization. Thus, for this attempt, the target reached the motor and the discrepancy remained within the servo/mechanical response. This does not identify whether friction, loading, control tuning, power delivery, or another motor-side condition caused it. In particular, a post-motion voltage reading cannot rule out supply sag during motion, and a zero status register cannot prove that all hardware is healthy.

All six servos responded with model number 777 and firmware 3.10. All reported torque enabled, position mode, status zero, and positions within the saved calibration ranges. Saved calibration matched the motors. Voltage registers ranged from 53 to 54; temperature registers ranged from 28 to 29. Gripper torque limits remained 500, as configured. The other four servos had goal equal to position; those stationary readbacks do not test their ability to move.

The service returned with boot `dd994e36-ee02-4034-873d-f0eccafafa5d`, fresh feedback about 54 ms old, no fault, and no control owner. Normal startup held the measured pose. No calibration, motion bound, completion tolerance, or gain setting was changed for this diagnostic. Evidence is in `var/pickup-retry-2026-09-09/`, including the transcript, four exact chat captures, before/after status, and `servo-registers.json`.

Next diagnosis should check the actual power-supply output and servo voltage labels, inspect for mechanical interference, and then capture goal, position, voltage, current, load, and status **during** a bounded probe through the sole motor owner. Stable power with persistent tracking error would motivate a reviewed investigation of friction and servo tuning; transient voltage loss would direct attention to the supply and wiring. Neither larger blind moves nor relaxed completion tolerances would resolve the uncertainty. The [LeRobot assembly guide](https://huggingface.co/docs/lerobot/main/en/assemble_so101#configure-motors) distinguishes 5 V supplies for the 7.4 V STS3215 variant from 12 V supplies for the 12 V variant, so the observed voltage alone is insufficient to call the supply incorrect.

## Later leader-control report

After reporting that browser joint controls produced motion, the operator tried the leader and reported that taking control did nothing. Read-only inspection found a different failure: the live observation contained `ValueError: Arm geometry intersects the configured table clearance`, with no current owner. The motor service had connected the leader three times; the last connection ran from 08:42:07 to 08:42:26 UTC before disconnecting. No competing controller or diagnostic movement was started during this investigation.

The leader path reads joint targets, rate-limits them to the configured 2 units/s, and validates each proposed pose. A geometry rejection currently follows the same latched-fault path as other motor-loop exceptions, closes the leader and revokes control. The browser then disabled both acquisition buttons because of `observation.fault`, but displayed only “Unavailable” and “Holding position”: it never rendered the fault itself. This hid the immediate cause from the operator.

The UI now displays a persistent fault explanation, identifies control as stopped, and keeps Stop/Hold available. This changes presentation only. The geometry check, latch, joint limits, speed, motor configuration, and control-acquisition behavior are unchanged. “Take manual control” enables browser joint buttons; “Use leader arm” starts following the leader's absolute joint targets at the configured rate.

At inspection, the measured pose passed the existing model validation, with an estimated 20.35 mm margin above the gripper-frame clearance boundary. The last commanded pose also passed, but had only about 0.072 mm estimated margin; the next proposed leader pose triggered rejection. These are model calculations, not physical clearance measurements. The camera shows the gripper close to the mat and cannot independently rule out contact. The operator was asked to verify clearance before restoring motor control. The motor service was not restarted to clear this fault during the inspection.

Evidence is retained in `var/leader-fault-2026-09-09/`, including the full observation and fresh camera captures. This leader result does not establish why the earlier bounded moves stopped short of their targets.

Validation for the fault display: the full repository check passed (132 Bun tests and 83 Python tests), and the production build passed. The browser fixture exercises manual acquisition/renewal/release, an injected observation fault, disabled acquisition controls, persistent fault text after Stop, and mobile layout. The fixture uses mock hardware and does not establish real leader-following safety.
