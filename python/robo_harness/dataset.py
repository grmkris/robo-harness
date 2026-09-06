"""Finalize captured samples into a native LeRobot v3 dataset; never upload implicitly."""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

from .kinematics import JOINTS


def resample(samples, fps):
    if not samples:
        raise ValueError("Recording has no samples")
    times = np.array([sample["sample_time_ms"] for sample in samples], dtype=float)
    if not np.all(np.isfinite(times)) or np.any(np.diff(times) <= 0):
        raise ValueError("Recording timestamps must be finite and strictly increasing")
    if np.any(np.diff(times) > 250):
        raise ValueError("Recording contains a gap over 250 ms; do not compress missing time")
    regular = np.arange(times[0], times[-1] + 0.001, 1000 / fps)
    return [samples[int(np.argmin(np.abs(times - value)))] for value in regular]


def export_recording(source: Path, destination: Path, repo_id: str):
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    manifest = json.loads((source / "manifest.json").read_text())
    if manifest["state"] not in ("captured", "finalized"):
        raise ValueError("Only complete captured recordings can be exported")
    samples = [json.loads(line) for line in (source / "samples.jsonl").read_text().splitlines()]
    if not samples:
        raise ValueError("Recording has no samples")
    shapes = {}
    for name, frame in samples[0]["images"].items():
        shapes[name] = (frame["height"], frame["width"], 3)
    features = {
        "observation.state": {"dtype": "float32", "shape": (6,), "names": list(JOINTS)},
        "action": {"dtype": "float32", "shape": (6,), "names": list(JOINTS)},
        **{
            f"observation.images.{name}": {
                "dtype": "video",
                "shape": shape,
                "names": ["height", "width", "channels"],
            }
            for name, shape in shapes.items()
        },
    }
    dataset = LeRobotDataset.create(
        repo_id=repo_id,
        fps=manifest["sampling_fps"],
        root=destination,
        robot_type="so101_follower",
        features=features,
        use_videos=True,
    )
    try:
        for sample in resample(samples, manifest["sampling_fps"]):
            frame = {
                "observation.state": np.array(
                    [sample["observation"]["measured"][j] for j in JOINTS], dtype=np.float32
                ),
                "action": np.array([sample["observation"]["commanded"][j] for j in JOINTS], dtype=np.float32),
                "task": manifest["label"],
            }
            for name, metadata in sample["images"].items():
                frame[f"observation.images.{name}"] = np.array(
                    Image.open(source / metadata["path"]).convert("RGB")
                )
            dataset.add_frame(frame)
        dataset.save_episode()
        dataset.finalize()
    except Exception:
        (destination / "INCOMPLETE").write_text("Export failed; do not use this dataset for training.")
        raise
    manifest.update(state="finalized", lerobot_dataset=str(destination), repo_id=repo_id)
    (source / "manifest.json").write_text(json.dumps(manifest, indent=2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("recording", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--repo-id", default="local/robo-harness")
    args = parser.parse_args()
    export_recording(args.recording, args.output, args.repo_id)
