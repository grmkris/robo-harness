"""Trace one servo through small bounded steps: goal, position, voltage, current, load.

Run on the robot host with robo-io STOPPED (it keeps torque on when stopped, so
the arm holds). This process becomes the only motor owner for the duration,
takes the same follower lock, never changes Torque_Enable or calibration, and
leaves the joint holding its start position with P restored.

    python scripts/servo_step_trace.py --profile config/robot.lab-pi.json \
        --joint wrist_flex --step -1.8 --p-values 16,32 --report /tmp/trace.json
"""

import argparse
import fcntl
import json
import time
from pathlib import Path

MAX_STEP_DEG = 2.0
REGISTERS = (
    "Present_Position",
    "Present_Voltage",
    "Present_Current",
    "Present_Load",
    "Present_Temperature",
    "Moving",
    "Status",
)
# A servo hotter than this ends the trace: STS3215 protection trips around 70 C.
MAX_TEMPERATURE_C = 60


def signed(value: int, bit: int) -> int:
    """Feetech sign-magnitude: bit `bit` carries the sign."""
    return -(value & ((1 << bit) - 1)) if value & (1 << bit) else value


def main() -> None:
    # Imported lazily: LeRobot is only installed on the robot host.
    from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig  # noqa: PLC0415

    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--profile", required=True)
    parser.add_argument("--joint", required=True)
    parser.add_argument("--step", type=float, required=True, help="degrees, |step| <= 2")
    parser.add_argument("--p-values", default="16", help="comma-separated P coefficients to compare")
    parser.add_argument("--hold-s", type=float, default=2.5)
    parser.add_argument(
        "--rest-s",
        type=float,
        default=2.0,
        help="after each P, sample the holding joint at rest for this long: position spread shows buzzing",
    )
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    if abs(args.step) > MAX_STEP_DEG:
        raise SystemExit(f"|step| must be <= {MAX_STEP_DEG} degrees")
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
    lock = Path("/tmp/robo-harness-follower.lock").open("w")  # noqa: SIM115 (held until finally)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    bus = robot.bus
    joint = args.joint
    report: dict = {"joint": joint, "step_deg": args.step, "started_ms": time.time() * 1000, "trials": []}
    start_deg = None
    original_p = None
    try:
        bus.connect()
        if bus.read("Torque_Enable", joint, normalize=False) != 1:
            raise RuntimeError("Torque is off; this trace only runs against a holding joint")
        start_deg = bus.read("Present_Position", joint)
        original_p = bus.read("P_Coefficient", joint, normalize=False)
        low, high = profile["limits"][joint]
        target = start_deg + args.step
        if not low <= target <= high:
            raise RuntimeError(f"target {target:.2f} outside profile limits {low}..{high}")
        report["start_deg"] = start_deg
        report["original_p"] = original_p
        report["other_joints_deg"] = {j: bus.read("Present_Position", j) for j in bus.motors}

        def sample(label: str, goal: float, p: int) -> dict:
            bus.write("Goal_Position", joint, goal)
            t0 = time.monotonic()
            rows = []
            while time.monotonic() - t0 < args.hold_s:
                row = {"t": round(time.monotonic() - t0, 3)}
                for reg in REGISTERS:
                    normalize = reg == "Present_Position"
                    row[reg] = bus.read(reg, joint, normalize=normalize)
                row["Present_Load"] = signed(row["Present_Load"], 10)
                row["Present_Current"] = signed(row["Present_Current"], 15)
                rows.append(row)
            final = rows[-1]["Present_Position"]
            hottest = max(r["Present_Temperature"] for r in rows)
            if hottest > MAX_TEMPERATURE_C:
                raise RuntimeError(f"{joint} reached {hottest} C; trace stopped to protect the servo")
            summary = {
                "label": label,
                "p": p,
                "goal_deg": round(goal, 3),
                "from_deg": round(rows[0]["Present_Position"], 3),
                "final_deg": round(final, 3),
                "moved_deg": round(final - rows[0]["Present_Position"], 3),
                "residual_deg": round(abs(goal - final), 3),
                "voltage_min_V": min(r["Present_Voltage"] for r in rows) / 10,
                "voltage_max_V": max(r["Present_Voltage"] for r in rows) / 10,
                "current_peak_mA": max(abs(r["Present_Current"]) for r in rows) * 6.5,
                "load_peak_pct": max(abs(r["Present_Load"]) for r in rows) / 10,
                "status_values": sorted({r["Status"] for r in rows}),
                "temperature_max_C": hottest,
                "samples": len(rows),
                "rows": rows,
            }
            print(json.dumps({k: v for k, v in summary.items() if k != "rows"}), flush=True)
            return summary

        for p in [int(v) for v in args.p_values.split(",")]:
            bus.write("P_Coefficient", joint, p, normalize=False)
            applied = bus.read("P_Coefficient", joint, normalize=False)
            if applied != p:
                report["trials"].append({"p": p, "error": f"P write not applied (read back {applied})"})
                print(json.dumps(report["trials"][-1]), flush=True)
                continue
            report["trials"].append(sample(f"P{p} out", target, p))
            report["trials"].append(sample(f"P{p} back", start_deg, p))
            # Buzzing shows as position spread while nothing is commanded.
            t0 = time.monotonic()
            rest = []
            while time.monotonic() - t0 < args.rest_s:
                rest.append(bus.read("Present_Position", joint))
            spread = max(rest) - min(rest) if rest else 0.0
            report["trials"].append(
                {"label": f"P{p} rest", "p": p, "rest_spread_deg": round(spread, 3), "samples": len(rest)}
            )
            print(json.dumps(report["trials"][-1]), flush=True)
        report["result"] = "completed"
    except BaseException as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        try:
            if bus.is_connected:
                if original_p is not None:
                    bus.write("P_Coefficient", joint, original_p, normalize=False)
                if start_deg is not None:
                    bus.write("Goal_Position", joint, start_deg)
                    time.sleep(1.0)
                    report["end_deg"] = bus.read("Present_Position", joint)
                report["end_p"] = bus.read("P_Coefficient", joint, normalize=False)
                bus.disconnect(disable_torque=False)
        finally:
            report["finished_ms"] = time.time() * 1000
            Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
            lock.close()


if __name__ == "__main__":
    main()
