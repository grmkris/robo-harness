"""Explicit, at-most-two-degree recovery into saved calibration; never recalibrate."""

import argparse
import fcntl
import json
import time
from dataclasses import asdict
from pathlib import Path

from robo_harness.drivers import configure_follower_with_hold


def main():
    from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--joint", required=True)
    parser.add_argument("--target-raw", required=True, type=int)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    profile = json.loads(Path(args.profile).read_text())
    robot = SO101Follower(
        SO101FollowerConfig(
            port=profile["port"],
            id=profile["robot_id"],
            use_degrees=True,
            calibration_dir=Path(profile["calibration_dir"]),
            disable_torque_on_disconnect=False,
        )
    )
    owner_lock = open("/tmp/robo-harness-follower.lock", "w")
    fcntl.flock(owner_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    report = {"joint": args.joint, "target_raw": args.target_raw, "started_ms": time.time() * 1000}
    try:
        robot.bus.connect()
        if not robot.is_calibrated:
            raise ValueError("Calibration registers do not match the saved files")
        report["calibration_before"] = {j: asdict(c) for j, c in robot.bus.read_calibration().items()}
        report["before"] = robot.bus.sync_read("Present_Position", normalize=False)
        configure_follower_with_hold(robot.bus, {args.joint: args.target_raw})
        time.sleep(2)
        report["after"] = robot.bus.sync_read("Present_Position", normalize=False)
        report["torque"] = {j: robot.bus.read("Torque_Enable", j, normalize=False) for j in robot.bus.motors}
        report["calibration_after"] = {j: asdict(c) for j, c in robot.bus.read_calibration().items()}
        if report["calibration_before"] != report["calibration_after"]:
            raise ValueError("Calibration registers changed unexpectedly")
        for j, value in report["after"].items():
            c = robot.bus.calibration[j]
            if not c.range_min <= value <= c.range_max:
                raise ValueError(f"{j} is still outside calibration after the bounded recovery")
        report["result"] = "recovered; holding position"
    except BaseException as e:
        report["error"] = str(e)
        raise
    finally:
        if robot.bus.is_connected:
            robot.bus.disconnect(disable_torque=False)
        Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))
        owner_lock.close()


if __name__ == "__main__":
    main()
