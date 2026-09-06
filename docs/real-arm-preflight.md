# Real-arm deployment — 2026-09-06/07

The user confirmed the workspace was clear and authorized powered movement. The standalone harness is deployed and controlling the real follower on lab-pi; no GPU or operator login is required.

## Running layout

- Workbench: http://100.105.51.45:8940, Tailscale access without login.
- Netcup development checkout: `/home/kristjan/code/robo-harness` (branch `main`).
- Netcup deployment: `/home/kristjan/code/robo-harness-deploy`, a git worktree on the `deploy` branch that only ever fast-forwards to a tagged release; both systemd units run from it. Data (sqlite, tokens, recordings, workspaces) lives in `/home/kristjan/.local/state/robo-harness` via `ROBO_DATA_DIR`, so a checkout can be replaced without touching evidence.
- Netcup user services: `robo-app.service` and `robo-rerun.service`, enabled with user lingering already active.
- Pi: `kris@100.77.154.45`; deployment `/home/kris/robo-harness`.
- Pi system service: `robo-io.service`, running as the existing lab user. It has `Restart=no` and is deliberately not enabled at boot; start explicitly after checking hardware.
- Pi I/O binds to `100.77.154.45:8941`. Rerun binds to Netcup loopback and is proxied by the workbench.
- `labcam-preview.service` is stopped while the harness owns cameras. Both use the same `lab_cameras.CameraOwner` and `/run/lock/lab-cams.lock`.
- The Pi has an isolated Python 3.12 environment with SciPy 1.17.1. A `.pth` imports the existing `/home/kris/lab/.venv` site packages, including LeRobot 0.6.0 and the installed lab camera package. The existing lab environment was not modified. Moving that lab environment requires updating the harness environment too.
- Recordings live on Netcup. No GPU packages or large model checkpoints were installed on the Pi.

## Calibration and first activation

Both arms responded on all six motors. Calibration files were absent from `/data/lerobot/calibration`; full calibration was recovered from the motor registers into `var/preflight/calibration`. Copies are deployed under the Pi's `calibration/follower` and `calibration/leader`, both with robot ID `arm`.

The initial folded elbow was at raw 3152, eight ticks beyond its saved maximum 3144. Two explicit recovery attempts commanded raw 3136 and 3130, each bounded to at most two degrees from its measured startup pose. The first settled at 3147; the second at 3142, inside the existing range. All other joints stayed at their initial readings. Calibration registers were identical before and after each attempt. Torque is now enabled and the service holds commanded positions.

Ordinary startup never performs this recovery automatically: it loads a measured-position goal before enabling torque and rejects out-of-range poses. `scripts/recover_startup_pose.py` is a separate explicit tool for small inward recovery. The LeRobot adapter also converts its relative limit to float, as required by LeRobot's motion helper.

The real profile is `config/robot.lab-pi.json`: register-derived joint limits, maximum step 2 degrees/percentage points, maximum speed 2 units/s, and Cartesian control disabled. The lab URDF and coarse table/workspace envelope support visualization and basic checks; they are not calibrated grasp geometry or a complete collision model.

## End-to-end evidence

`var/real-arm-acceptance/motion.json` contains the MCP acceptance result:

- Real joint observations and both 640×480 camera image blocks with matching clock domains and fresh capture timestamps.
- Agent lease, gripper opening target +2 percentage points over 1.5 seconds, measured movement +1.775956 percentage points.
- Measured completion; all five arm joints unchanged during the gripper test.
- Stop revoked control and preserved the commanded hold position.
- Recording `379fe264-b58d-4c95-8b04-3e00aa5ec94b`: 46 samples, 92 camera images, no missed recording samples, 4,595,169-byte Rerun replay.
- `rerun rrd verify` passed. The browser loaded the replay and returned to live Rerun successfully.
- The deployed workbench opens without a token over its actual HTTP Tailscale address. Its container Python client reads real, fault-free observations.
- Browser wrist-roll jog: target +2 degrees, measured +1.230769 degrees at completion (0.769231-degree residual within the 0.8-degree tolerance), followed by stop with no active controller. Evidence: `var/real-arm-acceptance/browser-wrist-jog.json`.

## Operations

```sh
# Netcup
systemctl --user status robo-app robo-rerun
journalctl --user -u robo-app -u robo-rerun -n 50

# Pi: inspect before a manual restart; a restart configures and enables motors.
ssh kris@100.77.154.45 'sudo systemctl status robo-io'
ssh kris@100.77.154.45 'sudo journalctl -u robo-io -n 50'
```

Use the workbench Stop/Hold button to cancel motion and revoke control. Stopping the I/O service closes devices while retaining torque/hold; it does not release the arm. To return camera ownership, stop `robo-io` before starting `labcam-preview`. After a Pi reboot, start `robo-io` explicitly; its service conflict handles camera ownership.

## Remaining optional work

Built-in chat still needs an explicitly configured provider account; external LLMs already use MCP. SAM3/depth inference is optional and needs a worker/model setup. Camera extrinsics, Cartesian picking, leader-following motion, and a dedicated Pi development shell have not been physically commissioned. Netcup's development container and robot API are working now.
