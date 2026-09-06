"""Separate Netcup telemetry process. Latest-sample polling bounds memory and never blocks motors."""

import argparse
import base64
import io
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx
import numpy as np
import rerun as rr
import rerun.blueprint as rrb
from PIL import Image


def blueprint():
    return rrb.Blueprint(
        rrb.Horizontal(
            rrb.Vertical(
                rrb.Spatial3DView(origin="world", name="SO-101 / base frame"),
                rrb.TimeSeriesView(origin="joints", name="Commanded · measured"),
                row_shares=[3, 1],
            ),
            rrb.Vertical(
                rrb.Spatial2DView(origin="cameras/workspace", name="Workspace"),
                rrb.Spatial2DView(origin="cameras/wrist", name="Wrist"),
                rrb.Spatial2DView(origin="perception", name="Perception / source frame"),
                row_shares=[1, 1, 1],
            ),
            column_shares=[3, 2],
        ),
        rrb.TimePanel(timeline="capture", expanded=True),
        rrb.SelectionPanel(expanded=False),
        rrb.BlueprintPanel(expanded=False),
    )


def initialize(stream):
    rr.send_blueprint(blueprint(), recording=stream)
    stream.log("world", rr.ViewCoordinates.RIGHT_HAND_Z_UP, static=True)
    stream.log("world/origin", rr.Transform3D(translation=[0, 0, 0]), static=True)
    stream.log("world/origin", rr.TransformAxes3D(0.06), static=True)
    lines = []
    for p in np.arange(-0.5, 0.51, 0.05):
        lines.extend([[[-0.5, p, 0], [0.5, p, 0]], [[p, -0.5, 0], [p, 0.5, 0]]])
    stream.log("world/grid", rr.LineStrips3D(lines, colors=[70, 83, 75], radii=0.0004), static=True)


def log_observation(stream, observation):
    stream.set_time("capture", timestamp=observation["wall_time_ms"] / 1000)
    stream.set_time("device_sequence", sequence=observation["seq"])
    stream.log("metadata/calibration", rr.TextDocument(observation["calibration_id"]))
    stream.log("metadata/clock_domain", rr.TextDocument(observation["clock_domain"]))
    for j, value in observation["measured"].items():
        stream.log("joints/" + j + "/measured", rr.Scalars(value))
        stream.log("joints/" + j + "/commanded", rr.Scalars(observation["commanded"][j]))
    order = [
        "base_link",
        "shoulder_link",
        "upper_arm_link",
        "lower_arm_link",
        "wrist_link",
        "gripper_link",
        "gripper_frame_link",
    ]
    frames = observation["frames"]
    points = [np.array(frames[name])[:3, 3] for name in order if name in frames]
    if points:
        stream.log("world/arm", rr.LineStrips3D([points], radii=0.008, colors=[224, 174, 78]))
        stream.log("world/joints", rr.Points3D(points, radii=0.012, colors=[178, 189, 178]))
    for name, transform in frames.items():
        matrix = np.array(transform)
        stream.log("world/frames/" + name, rr.Transform3D(translation=matrix[:3, 3], mat3x3=matrix[:3, :3]))
    stream.log("world/frames/gripper_frame_link", rr.TransformAxes3D(0.04))
    trajectory = observation.get("trajectory", [])
    stream.log(
        "world/trajectory",
        rr.LineStrips3D([trajectory] if trajectory else [], radii=0.002, colors=[110, 205, 172]),
    )


def log_frame(stream, frame):
    stream.set_time("capture", timestamp=frame["wall_time_ms"] / 1000)
    stream.set_time("device_sequence", sequence=frame["seq"])
    path = "cameras/" + frame["camera"]
    stream.log(
        path, rr.EncodedImage(contents=base64.b64decode(frame["base64"]), media_type=frame["media_type"])
    )
    stream.log(path + "/frame_id", rr.TextDocument(frame["id"]))
    calibration = frame.get("calibration")
    if calibration and calibration.get("intrinsics"):
        stream.log(
            path,
            rr.Pinhole(
                image_from_camera=calibration["intrinsics"], width=frame["width"], height=frame["height"]
            ),
        )


def log_perception(stream, result):
    source = result["source"]
    stream.set_time("capture", timestamp=source["wall_time_ms"] / 1000)
    stream.log(
        "perception/preview",
        rr.EncodedImage(contents=base64.b64decode(result["preview_png"]), media_type="image/png"),
    )
    stream.log(
        "perception/source",
        rr.TextDocument(
            json.dumps(
                {
                    "frame_id": source["id"],
                    "model": result["model"],
                    "completed_ms": result["completed_ms"],
                    "units": result.get("units"),
                },
                indent=2,
            )
        ),
    )
    if result.get("depth"):
        depth = np.array(result["depth"], dtype=np.float32)
        # Relative estimates stay a tensor: never present them as measured metric depth.
        if result.get("units") == "meters":
            stream.log("perception/depth", rr.DepthImage(depth, meter=1.0))
        else:
            stream.log("perception/depth", rr.Tensor(depth))
    for i, mask in enumerate(result.get("masks", [])):
        image = np.array(Image.open(io.BytesIO(base64.b64decode(mask["png"]))))
        stream.log(f"perception/mask_{i}", rr.SegmentationImage((image > 0).astype(np.uint8)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=os.environ.get("ROBO_URL", "http://127.0.0.1:8940"))
    parser.add_argument("--web-port", type=int, default=8942)
    parser.add_argument("--grpc-port", type=int, default=8943)
    args = parser.parse_args()
    token = os.environ.get("ROBO_WORKER_TOKEN", "")
    if len(token) < 24:
        parser.error("ROBO_WORKER_TOKEN is required")
    data = Path(os.environ.get("ROBO_DATA_DIR", "var")).resolve()
    # Python serve_grpc has no bind argument; use the CLI to enforce loopback-only listeners.
    process = subprocess.Popen(
        [
            str(Path(sys.executable).with_name("rerun")),
            "--serve-web",
            "--bind",
            "127.0.0.1",
            "--port",
            str(args.grpc_port),
            "--web-viewer-port",
            str(args.web_port),
            "--server-memory-limit",
            "32MiB",
        ],
        stdout=subprocess.DEVNULL,
        start_new_session=True,
    )
    stopped = False

    def halt(*_):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, halt)
    signal.signal(signal.SIGINT, halt)
    live = rr.RecordingStream("robo-harness", recording_id=uuid.uuid4())
    live.connect_grpc(f"rerun+http://127.0.0.1:{args.grpc_port}/proxy")
    initialize(live)
    saved = None
    saved_id = None
    after = 0
    seen_frames = {}
    camera_logged_at = {}
    seen_perception = set()
    last_seq = None
    dropped = 0
    last_heartbeat = 0
    error = None
    with httpx.Client(headers={"Authorization": "Bearer " + token}, timeout=2) as client:
        try:
            while not stopped:
                started = time.monotonic()
                try:
                    response = client.get(args.url + "/api/telemetry", params={"after": after})
                    response.raise_for_status()
                    packet = response.json()
                    active = packet.get("recording")
                    next_id = active["id"] if active and active["state"] == "recording" else None
                    if next_id != saved_id:
                        if saved:
                            saved.flush(timeout_sec=2)
                            saved.disconnect()
                        saved = None
                        saved_id = next_id
                        if next_id:
                            folder = data / "recordings" / str(uuid.UUID(next_id))
                            folder.mkdir(parents=True, exist_ok=True)
                            saved = rr.RecordingStream("robo-harness", recording_id=next_id)
                            saved.save(folder / "replay.rrd", default_blueprint=blueprint())
                            initialize(saved)
                    streams = [live] + ([saved] if saved else [])
                    obs = packet.get("observation")
                    if obs and time.time() * 1000 - packet.get("received_at", 0) < 1000:
                        key = (obs["boot_id"], obs["seq"])
                        if key != last_seq:
                            if last_seq and last_seq[0] == key[0]:
                                dropped += max(0, key[1] - last_seq[1] - 3)
                            for stream in streams:
                                log_observation(stream, obs)
                                stream.log(
                                    "metadata/clock_sync", rr.TextDocument(json.dumps(packet["clock"]))
                                )
                            last_seq = key
                    for name, frame in packet.get("frames", {}).items():
                        if seen_frames.get(name) != frame["id"]:
                            if saved:
                                log_frame(saved, frame)
                            if time.monotonic() - camera_logged_at.get(name, 0) >= 0.33:
                                log_frame(live, frame)
                                camera_logged_at[name] = time.monotonic()
                            seen_frames[name] = frame["id"]
                    for event in packet.get("events", []):
                        after = max(after, event["id"])
                        for stream in streams:
                            stream.set_time("capture", timestamp=event["time"] / 1000)
                            stream.log("events/" + event["type"], rr.TextLog(json.dumps(event["data"])))
                    for result in packet.get("perception", []):
                        if result["id"] not in seen_perception:
                            for stream in streams:
                                log_perception(stream, result)
                            seen_perception.add(result["id"])
                    error = None
                    if process.poll() is not None:
                        raise RuntimeError("Rerun viewer server exited")
                except Exception as e:
                    error = f"{type(e).__name__}: {e}"
                if time.monotonic() - last_heartbeat > 1:
                    try:
                        client.post(
                            args.url + "/api/telemetry/heartbeat",
                            json={
                                "error": error,
                                "dropped": dropped,
                                "version": rr.__version__,
                                "recording_id": saved_id,
                            },
                        )
                    except Exception:
                        pass
                    last_heartbeat = time.monotonic()
                time.sleep(max(0, 0.1 - (time.monotonic() - started)))
        finally:
            if saved:
                saved.flush(timeout_sec=2)
                saved.disconnect()
            live.disconnect()
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)


if __name__ == "__main__":
    main()
