"""LeRobot is the motor driver. Real hardware is opt-in and never auto-calibrates."""

import fcntl
import os
from pathlib import Path
from typing import Any

from .kinematics import JOINTS

# A startup recovery nudge may move an out-of-range joint at most this many degrees.
MAX_RECOVERY_DEGREES = 2


class MockDriver:
    def __init__(self) -> None:
        self.q: dict[str, float] = dict.fromkeys(JOINTS, 0.0)
        self.q["gripper"] = 40.0

    def read(self) -> dict[str, float]:
        return self.q.copy()

    def write(self, values: dict[str, float]) -> None:
        self.q = values.copy()

    def close(self) -> None:
        pass


def configure_follower_with_hold(bus: Any, recovery_targets: dict[str, int] | None = None) -> None:
    """LeRobot 0.6 follower settings, with a current-position goal before torque.

    A configuration failure leaves torque disabled. The standard context manager
    can re-enable it even when configuration raises, so use explicit sequencing.
    """
    bus.disable_torque()
    bus.configure_motors()
    for motor in bus.motors:
        bus.write("Operating_Mode", motor, 0)  # Feetech POSITION mode.
        bus.write("P_Coefficient", motor, 16)
        bus.write("I_Coefficient", motor, 0)
        bus.write("D_Coefficient", motor, 32)
        if motor == "gripper":
            bus.write("Max_Torque_Limit", motor, 500)
            bus.write("Protection_Current", motor, 250)
            bus.write("Overload_Torque", motor, 25)
    positions = bus.sync_read("Present_Position", normalize=False)
    if set(positions) != set(bus.motors):
        raise ValueError("Incomplete startup motor observation; torque remains disabled")
    goals = positions.copy()
    for name, target in (recovery_targets or {}).items():
        if name not in positions or name == "gripper":
            raise ValueError("Startup recovery requires a known arm joint")
        calibration = bus.calibration[name]
        if calibration.range_min <= positions[name] <= calibration.range_max:
            raise ValueError("Startup recovery only applies to an out-of-range rest pose")
        if not isinstance(target, int) or abs(target - positions[name]) * 360 / 4095 > MAX_RECOVERY_DEGREES:
            raise ValueError("Startup recovery is limited to two degrees")
        goals[name] = target
    for name, value in goals.items():
        calibration = bus.calibration[name]
        if not calibration.range_min <= value <= calibration.range_max:
            raise ValueError(
                f"{name} is outside its saved calibration range; reposition with torque off before connecting"
            )
    bus.sync_write("Goal_Position", goals, normalize=False)
    bus.enable_torque()


class LeRobotDriver:
    def __init__(self, profile: dict[str, Any], leader: bool = False) -> None:
        if (
            not profile.get("commissioned")
            or not profile.get("profile_review")
            or profile.get("hold_mode") != "commanded"
        ):
            raise ValueError("Real hardware requires a reviewed commissioned profile and commanded hold")
        # Keep the motor lock out of world-writable /tmp (symlink and eviction
        # hazards): prefer the per-user runtime dir, fall back to /run/lock.
        lock_dir = os.environ.get("XDG_RUNTIME_DIR") or "/run/lock"
        lock_name = "robo-harness-leader.lock" if leader else "robo-harness-follower.lock"
        # Long-lived flock handle, deliberately not context-managed.
        self._lock = (Path(lock_dir) / lock_name).open("w")
        fcntl.flock(self._lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.is_leader = leader
        if leader:
            from lerobot.teleoperators.so_leader import SO101Leader, SO101LeaderConfig  # noqa: PLC0415

            cfg = SO101LeaderConfig(
                port=profile["leader_port"],
                id=profile.get("leader_id", "leader"),
                use_degrees=True,
                calibration_dir=Path(profile["leader_calibration_dir"]),
            )
            self.robot = SO101Leader(cfg)
        else:
            from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig  # noqa: PLC0415

            cfg = SO101FollowerConfig(
                port=profile["port"],
                id=profile["robot_id"],
                use_degrees=True,
                calibration_dir=Path(profile["calibration_dir"]),
                max_relative_target=float(profile["max_step"]),
                disable_torque_on_disconnect=False,
            )

            class CurrentHoldFollower(SO101Follower):
                def configure(self):
                    if not self.is_calibrated:
                        raise ValueError(
                            "Motor calibration is missing or mismatched; restore it before activation"
                        )
                    configure_follower_with_hold(self.bus)

            self.robot = CurrentHoldFollower(cfg)
        try:
            if set(self.robot.bus.motors) != set(JOINTS):
                raise ValueError("Motor set does not match all six SO-101 joints")
            if leader and not self.robot.calibration:
                raise ValueError("Leader calibration is missing")
            self.robot.connect(calibrate=False)
            if not self.robot.is_calibrated:
                raise ValueError("Motor calibration is mismatched")
        except Exception:
            if self.robot.bus.is_connected:
                self.robot.bus.disconnect(disable_torque=False)
            self._lock.close()
            raise

    def read(self) -> dict[str, float]:
        obs = self.robot.get_action() if self.is_leader else self.robot.get_observation()
        return {j: float(obs[f"{j}.pos"]) for j in JOINTS}

    def write(self, values: dict[str, float]) -> None:
        self.robot.send_action({f"{j}.pos": v for j, v in values.items()})

    def close(self) -> None:
        self.robot.disconnect()
        self._lock.close()
