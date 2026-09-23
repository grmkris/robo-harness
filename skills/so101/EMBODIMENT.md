# SO-101 embodiment

The SO-101 has five rotary arm joints and one gripper. Joint values are degrees; gripper values are percent open (0 closed, 100 open). Distances are metres in base_link. Positive z is up. A reported pose is derived from measured joints and the calibrated kinematic model, not an independent position sensor.

The jaws close onto the fixed finger. Align the intended contact surface with the fixed jaw's inner face; the open gap's visual centre is not the grasp centre. Wrist roll changes the jaw orientation and rotates any lateral TCP offset.

The tool centre point (TCP) is the measured meeting point of the closed jaws. It differs from gripper_frame_link. Move tools apply the configured offset in that frame, including its orientation. Use the returned TCP and calibration information; do not substitute the model frame origin or guess an offset.

The commissioned safe polygon and maximum radius bound motion. The current lab arm reliably holds only about 0.17 m radial reach; 0.20 m and beyond encountered a torque wall. A geometrically solvable pose can still fail under load. Never raise gains, change limits, or disable a guard to reach it.

The workspace camera is fixed and gives the broad scene, table-plane position when calibrated, and independent evidence of lift. The wrist camera gives close alignment. A table homography applies only to points on that plane; applying it to a raised surface introduces parallax error. Camera orientation and lighting can change between setups; use current images and calibration rather than remembered pixel directions.

A downward step that does not settle is a possible contact signal. Stop immediately; it may be the table, an object, a joint stall, or another obstruction. It is not permission to push harder. The tools stop at the first failed step. A gripper that stops short while closing may contain an object; a completed close with no obstruction is not a grasp. Verify both with fresh images, then verify that the object moves with the jaws during a lift.

Camera dropouts can be electrical and occur under load. A transient stale-camera result means wait and look again. Do not switch control modes or continue blind. Unknown motion outcomes, faults, operator takeover, and excessive temperature end motion until the runtime/operator has established a safe state. Servo temperatures above 60 C require a cooling pause.
