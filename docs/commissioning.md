# Review and commission the Pi deployment

The user authorized deployment, confirmed a clear workspace, and the first powered tests have passed. See [the actual installed layout and evidence](real-arm-preflight.md). This document describes remaining commissioning and an optional stricter release layout; it does not require repeating the already granted activation approval.

## Known rig

- Pi: lab-pi / 100.77.154.45, Raspberry Pi 4, LeRobot 0.6.0.
- Follower: /dev/so101_follower. Leader: /dev/so101_leader.
- Cameras: /dev/cam_context and /dev/cam_wrist.
- Existing camera owner: labcam-preview on 8088, sharing /run/lock/lab-cams.lock.
- The external SSD is currently absent. /data is on the SD root filesystem.
- On 2026-09-06, both cameras and all 12 servos were read successfully. Torque was off on every motor. The calibration files under /data/lerobot/calibration are absent, but complete calibration remains in both arms' motor registers. See real-arm-preflight.md.

## Optional versioned release layout

1. Install this project's Python hardware dependencies into a dedicated environment, matching LeRobot 0.6.0. Keep the existing lab environment intact.
2. Create a hardware-service identity, separate from the development account. Grant it dialout/video and read access to the required calibration. Give the development account neither device access nor production configuration access.
3. Stage a versioned release under /opt/robo-harness/releases. A root-owned current symlink and /etc/robo-harness/robot.json select the reviewed version/profile.
4. Derive robot.json from the example. Set backend to so101 and camera_mode to lab to reuse the existing lab camera owner. Set calibration_dir, leader_calibration_dir, and the actual robot/leader IDs. Inspect full six-joint calibration, degrees, gripper percentage, and motor-to-URDF offsets.
5. Measure and document joint limits, maximum step/speed, table height, link clearance radius, workspace bounds, and keep-out boxes for this rig. The example values are not authorized real-world limits. Keep cartesian_reviewed false until FK/IK checks pass.
6. Set a specific calibration_id and profile_review note with the measurements/reviewer; set commissioned true only after this review.
7. Prepare private, matching I/O tokens in the Netcup environment and Pi /etc/robo-harness/io.env. Bind the Pi to its Tailscale address. Set Netcup ROBO_IO_URL to that private endpoint.
8. Review deploy/robo-io.service and any service/account changes before installation. The template deliberately has Restart=no: a fault must not automatically reconnect and re-enable hardware.

## Supervised acceptance

- Clear and secure the workspace, support the arm if torque changes, and verify the physical power cut-off is reachable.
- Stop existing motor programs. Confirm no process has either serial device open. Coordinate stopping labcam-preview immediately before the new camera owner starts; the shared flock rejects concurrent ownership.
- Start the reviewed service and check observation-only values against the physical pose. Connection never auto-calibrates, but LeRobot connection can enable torque.
- Verify the configured commanded-position hold behavior. Do not substitute measured-position tracking that could accumulate sag.
- Test very small joint/gripper movements, stop during motion, lease expiry, controller disconnect, and human takeover. Verify targets settle rather than merely being sent.
- Check FK against measured poses and short Cartesian moves before enabling cartesian_reviewed.
- Connect the leader with its own calibration, test takeover, and verify that relative positions, bounds, and rate limiting behave correctly.
- Disconnect a camera and the coordinator connection deliberately while supervised; verify relevant motion stops and faults are visible.
- A failed bus cannot guarantee hold. Review recovery manually; the service latches the fault.

## Rollback

Stop Robo Harness I/O before restarting labcam-preview or another motor owner. Restore the prior reviewed release/profile. Do not automatically release torque, resume an interrupted trajectory, or recalibrate during rollback.

## Pi development

Install deploy/robo-dev-shell for a dedicated robo-dev account. Its SSH identity belongs to the coordinator, while the agent sees only the development shell interface. Use a writable home workspace and an isolated Python environment.

Prepare proposed hardware changes in that workspace, run mock/static checks there, and review a diff against /opt/robo-harness/current. Only the operator/deployment identity may promote them into the active release.

## Two independent workflows: visual exploration and Cartesian positioning

Joint commissioning means motor readings, joint ranges and bounded motion have been checked. Cartesian commissioning additionally means the geometric model has been checked against the real arm: joint zero/sign conventions, link geometry, tool-center position, base frame, table and workspace clearances. The `so101-arm-registers-*` calibration ID identifies the motor calibration; it does not certify the camera or tool pose. The displayed `ee` is calculated by forward kinematics, not measured by a position sensor. Current IK targets position only, so tool orientation also needs review for a grasp task.

The operator requested visual exploration on 2026-09-08. A model may now select a small joint probe, observe the measured result and both cameras, and adapt its next choice while Cartesian commands remain disabled. The system prompt no longer requires the human to specify each angle or treats missing XYZ commissioning as a blanket refusal. See [decision 0009](decisions/0009-visual-joint-exploration.md).

For the calibrated workflow:

1. Re-establish a fixed reference target and camera identity. The previous lab experiment used a 5×7 ChArUco board, 35 mm squares, 26 mm markers, dictionary `DICT_4X4_250`. Verify printed dimensions and current placement. Its code can inform offline detection; do not run its direct motor-owner scripts alongside this harness.
2. Use the [tabletop calibration tool](tabletop-calibration.md) to validate pixel-to-plane mapping on independent check points. A board-coordinate mapping is not yet a robot-base mapping.
3. Establish the board/table relative to `base_link` and identify the exact physical gripper point represented by `gripper_frame_link`. Compare model predictions against independently measured positions at several distinct poses and heights, reached through existing bounded joint actions. Record joint readings, actual positions, approach direction and camera evidence; repeated approach directions help expose backlash and sag. Do not use the same FK model as its own ground truth.
4. Review position-only IK and complete link clearances for the intended local workspace. Record measured error and a task-specific tolerance. Stage any geometry/profile corrections for review; a passing image-plane fit alone cannot set `cartesian_reviewed`.
5. After geometry review, activate the reviewed profile and perform small supervised XYZ acceptance moves, then test gripper orientation and visual grasp verification. Increase task scope only from measured results.

Useful historical evidence: `~/code/so101-lab/gemini_er/calib.json`, `board_calibrate.py`, `wrist_calibrate.py` and `arm.py`. The August camera fit reports leave-one-out errors up to 16.2 mm after dropping four points. The board source notes a roughly 3–4 cm positioning shortfall before its affine correction. Those are reasons to investigate model/actuation conventions and collect current validation, not measurements of this harness's present error. None of the historical transforms has been imported into the deployed profile.
