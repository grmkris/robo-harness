"""Measure stream control on the real arm: one joint, out and back, bounded.

Streams absolute setpoints to a running `robo-io` at a target rate and records
what the joint actually did, so the stepped and streamed paths can be compared
on the same joint. The motor owner keeps ownership throughout: this script
never touches a serial port, and every limit, the geometry check and the
staleness hold stay in force.

    python scripts/stream_trace.py --url http://100.77.154.45:8941 \
        --token-file /home/kris/robo-harness/var/io-token \
        --joint wrist_flex --amplitude -3 --seconds 20 --report /tmp/stream.json

The caps here are the script's own: at most 3 degrees either way and 30
seconds, whatever is asked for.
"""

import argparse
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

MAX_AMPLITUDE_DEG = 3.0
MAX_SECONDS = 30.0
OWNER = "stream-trace"


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--url", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--joint", required=True)
    parser.add_argument("--amplitude", type=float, required=True, help="degrees, |a| <= 3")
    parser.add_argument("--seconds", type=float, default=20.0)
    parser.add_argument("--rate", type=float, default=10.0, help="setpoints per second")
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    if abs(args.amplitude) > MAX_AMPLITUDE_DEG:
        raise SystemExit(f"|amplitude| must be <= {MAX_AMPLITUDE_DEG} degrees")
    if not 0 < args.seconds <= MAX_SECONDS:
        raise SystemExit(f"--seconds must be within (0, {MAX_SECONDS}]")
    token = re.findall(r"[A-Za-z0-9_-]{16,}", Path(args.token_file).read_text())[0]

    def post(path: str, body: dict) -> dict:
        request = urllib.request.Request(
            args.url + path,
            data=json.dumps(body).encode(),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as reply:
            return json.load(reply)

    def observe() -> dict:
        request = urllib.request.Request(args.url + "/observe", headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(request, timeout=5) as reply:
            return json.load(reply)

    before = observe()
    if before["fault"]:
        raise SystemExit(f"Robot fault is latched: {before['fault']}")
    if before["operator"]:
        raise SystemExit(f"Another controller holds the arm: {before['operator']}")
    start = before["measured"][args.joint]
    report: dict = {
        "joint": args.joint,
        "amplitude_deg": args.amplitude,
        "rate_hz": args.rate,
        "start_deg": start,
        "before": before["measured"],
        "samples": [],
        "post_failures": [],
    }
    lease = post("/control/acquire", {"owner": OWNER, "mode": "stream"})
    try:
        began = time.monotonic()
        # Out for the first half, back for the second: a setpoint the joint has
        # to chase, then one it has to return from.
        while True:
            elapsed = time.monotonic() - began
            if elapsed >= args.seconds:
                break
            tick = time.monotonic()
            goal = start + (args.amplitude if elapsed < args.seconds / 2 else 0.0)
            try:
                reply = post(
                    "/control/stream",
                    {
                        "owner": OWNER,
                        "lease_id": lease["lease_id"],
                        "target": {args.joint: goal},
                    },
                )
            except urllib.error.HTTPError as error:
                report["post_failures"].append(
                    {"t": round(elapsed, 3), "status": error.code, "body": error.read()[:200].decode()}
                )
                continue
            report["samples"].append(
                {
                    "t": round(elapsed, 3),
                    "goal": round(goal, 3),
                    "commanded": round(reply["commanded"][args.joint], 3),
                    "measured": round(reply["measured"][args.joint], 3),
                    "rejected": reply["rejected"],
                    "round_trip_ms": round((time.monotonic() - tick) * 1000, 1),
                }
            )
            time.sleep(max(0.0, 1 / args.rate - (time.monotonic() - tick)))
        report["result"] = "completed"
    except BaseException as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        try:
            post("/control/release", {"owner": OWNER, "lease_id": lease["lease_id"]})
        finally:
            after = observe()
            samples = report["samples"]
            out = [s for s in samples if s["goal"] != round(start, 3)]
            back = [s for s in samples if s["goal"] == round(start, 3)]
            report["after"] = after["measured"]
            report["stream_state"] = after.get("stream")
            report["fault"] = after["fault"]
            report["posts"] = len(samples)
            report["achieved_hz"] = (
                round(len(samples) / samples[-1]["t"], 2) if samples and samples[-1]["t"] else None
            )
            report["round_trip_ms_p50"] = (
                round(sorted(s["round_trip_ms"] for s in samples)[len(samples) // 2], 1) if samples else None
            )
            # The number that matters: how far short of the setpoint the joint
            # settled, at the end of each half.
            if out:
                report["out_residual_deg"] = round(abs(out[-1]["measured"] - out[-1]["goal"]), 3)
                report["out_travel_deg"] = round(out[-1]["measured"] - start, 3)
            if back:
                report["back_residual_deg"] = round(abs(back[-1]["measured"] - back[-1]["goal"]), 3)
            report["finished_ms"] = time.time() * 1000
            Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
            print(
                json.dumps({k: v for k, v in report.items() if k != "samples"}, indent=2),
                flush=True,
            )


if __name__ == "__main__":
    main()
