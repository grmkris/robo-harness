"""Offline recording derivatives. Never open hardware or contact a model provider."""

import argparse
import json
import shutil
import sys
import textwrap
import zipfile
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

from .dataset import export_recording, resample
from .kinematics import JOINTS

MAX_DURATION_S = 300
MIN_EPISODE_SAMPLES = 2
CAMERA_WIDTH = 640
MAX_CAMERA_SKEW_MS = 150


def image_path(source: Path, value: str) -> Path:
    candidate = (source / value).resolve()
    if not candidate.is_relative_to((source / "images").resolve()) or not candidate.is_file():
        raise ValueError("Invalid recording image path")
    return candidate


def select_samples(samples: list[dict[str, Any]], selection: dict[str, Any]) -> list[dict[str, Any]]:
    if not samples:
        raise ValueError("Recording has no frames")
    field = "time_ms" if "time_ms" in samples[0] else "sample_time_ms"
    times = np.array([row[field] for row in samples], dtype=float)
    if not np.all(np.isfinite(times)) or np.any(np.diff(times) <= 0):
        raise ValueError("Recording timestamps are not strictly increasing")
    relative = (times - times[0]) / 1000
    start = float(selection.get("start_s", 0))
    end = float(selection.get("end_s", relative[-1]))
    if start < 0 or end <= start or end > relative[-1] + 0.101 or end - start > MAX_DURATION_S:
        raise ValueError("Choose an interval within the recording, up to 300 seconds")
    selected = [row for row, at in zip(samples, relative, strict=True) if start <= at <= end]
    if len(selected) < MIN_EPISODE_SAMPLES:
        raise ValueError("Selected interval needs at least two frames")
    return selected


def training_samples(samples: list[dict[str, Any]], fps: float) -> list[dict[str, Any]]:
    domain = samples[0]["observation"]["clock_domain"]
    for sample in samples:
        obs = sample["observation"]
        if obs["clock_domain"] != domain or obs.get("fault"):
            raise ValueError("Training interval contains a clock change or robot fault")
        for camera in ("workspace", "wrist"):
            frame = sample["images"][camera]
            if frame["clock_domain"] != domain:
                raise ValueError("Camera and robot clocks differ")
            skew = abs(frame["monotonic_s"] - obs["monotonic_s"]) * 1000
            if skew > MAX_CAMERA_SKEW_MS:
                raise ValueError("Camera/state skew exceeds 150 ms")
    aligned = resample(samples, fps)
    if len(aligned) < MIN_EPISODE_SAMPLES:
        raise ValueError("Training interval needs at least two frames after resampling")
    return aligned


def render_video(
    source: Path, target: Path, samples: list[dict[str, Any]], selection: dict[str, Any], fps: int
) -> None:
    import av  # noqa: PLC0415

    mode = selection.get("camera", "both")
    cameras = ["workspace", "wrist"] if mode == "both" else [mode]
    width = 640 * len(cameras)
    overlay = selection.get("overlay", True)
    height = 480 + (96 if overlay else 0)
    field = "time_ms" if "time_ms" in samples[0] else "sample_time_ms"
    times = np.array([row[field] for row in samples], dtype=float)
    ticks = np.arange(times[0], times[-1] + 0.001, 1000 / fps * selection.get("speed", 1))
    font = ImageFont.load_default(size=18)
    with av.open(str(target), mode="w") as container:
        stream = container.add_stream("libx264", rate=fps)
        stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
        stream.options = {"crf": "20", "preset": "fast"}
        for index, tick in enumerate(ticks):
            sample = samples[int(np.argmin(np.abs(times - tick)))]
            canvas = Image.new("RGB", (width, height), "#121818")
            for slot, camera in enumerate(cameras):
                with Image.open(image_path(source, sample["images"][camera]["path"])) as image:
                    fitted = ImageOps.contain(image.convert("RGB"), (640, 480))
                    canvas.paste(fitted, (slot * 640 + (640 - fitted.width) // 2, (480 - fitted.height) // 2))
            if overlay:
                draw = ImageDraw.Draw(canvas)
                task = selection["task"][:100]
                draw.text((12, 489), task, fill="#e0e9e4", font=font)
                measured = sample["observation"]["measured"]
                values = "  ".join(f"{joint.replace('_', ' ')} {measured[joint]:.1f}" for joint in JOINTS)
                draw.text(
                    (12, 514),
                    "\n".join(textwrap.wrap(values, width=75 if width == CAMERA_WIDTH else 140)),
                    fill="#83d2a0",
                    font=font,
                )
                draw.text(
                    (12, 555),
                    f"{selection.get('outcome', 'unreviewed')} | {selection.get('speed', 1)}x | angles deg, gripper %",
                    fill="#a8b9b0",
                    font=font,
                )
            frame = av.VideoFrame.from_image(canvas)
            frame.pts = index
            frame.time_base = Fraction(1, fps)
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def export_selection(source: Path, destination: Path, selection: dict[str, Any]) -> dict[str, Any]:
    manifest = json.loads((source / "manifest.json").read_text())
    if manifest["state"] not in ("captured", "finalized", "incomplete"):
        raise ValueError("Stop recording before exporting")
    samples = [json.loads(line) for line in (source / "samples.jsonl").read_text().splitlines()]
    selected = select_samples(samples, selection)
    fps = int(manifest["sampling_fps"])
    destination.mkdir(parents=True, exist_ok=True)
    evidence = {
        "source_recording": manifest["id"],
        "selection": selection,
        "source_manifest": manifest,
        "source_frame_indices": [s["index"] for s in selected],
    }
    (destination / "episode.json").write_text(json.dumps(evidence, indent=2))
    if selection["kind"] == "mp4":
        render_video(source, destination / "clip.mp4", selected, selection, fps)
        return {"file": "clip.mp4", "samples": len(selected)}
    if manifest["state"] == "incomplete":
        raise ValueError("Incomplete recordings cannot become training episodes")
    if selection.get("speed", 1) != 1:
        raise ValueError("Training episodes preserve their original timing")
    aligned = training_samples(selected, fps)
    evidence["exported_source_frame_indices"] = [sample["index"] for sample in aligned]
    (destination / "episode.json").write_text(json.dumps(evidence, indent=2))
    raw = destination / "raw"
    (raw / "images").mkdir(parents=True)
    for sample in selected:
        for metadata in sample["images"].values():
            image = image_path(source, metadata["path"])
            shutil.copy2(image, raw / "images" / image.name)
    (raw / "samples.jsonl").write_text("".join(json.dumps(row) + "\n" for row in selected))
    (raw / "manifest.json").write_text(
        json.dumps({**manifest, "label": selection["task"], "state": "captured"})
    )
    export_recording(raw, destination / "dataset", "local/robo-harness")
    with zipfile.ZipFile(destination / "dataset.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.write(destination / "episode.json", "episode.json")
        for path in sorted((destination / "dataset").rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(destination))
    shutil.rmtree(raw)
    return {"file": "dataset.zip", "samples": len(selected)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    try:
        export_selection(args.source, args.destination, json.load(sys.stdin))
    except Exception as error:
        sys.stderr.write(f"Recording export failed: {error}\n")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
