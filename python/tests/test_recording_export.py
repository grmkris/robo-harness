import json

import av
import pytest
from PIL import Image
from robo_harness.recording_export import export_selection, image_path, select_samples, training_samples


def fixture(tmp_path):
    source = tmp_path / "recording"
    (source / "images").mkdir(parents=True)
    Image.new("RGB", (64, 48), "white").save(source / "images" / "camera.jpg")
    samples = []
    for index in range(6):
        frame = {
            "path": "images/camera.jpg",
            "clock_domain": "boot",
            "monotonic_s": 1 + index / 10,
            "width": 64,
            "height": 48,
        }
        samples.append(
            {
                "index": index,
                "time_ms": 1000 + index * 100,
                "sample_time_ms": 9000 + index * 150,
                "images": {"workspace": frame, "wrist": frame},
                "observation": {
                    "clock_domain": "boot",
                    "monotonic_s": 1 + index / 10,
                    "fault": None,
                    "measured": dict.fromkeys(
                        [
                            "shoulder_pan",
                            "shoulder_lift",
                            "elbow_flex",
                            "wrist_flex",
                            "wrist_roll",
                            "gripper",
                        ],
                        1,
                    ),
                },
            }
        )
    (source / "samples.jsonl").write_text("".join(json.dumps(row) + "\n" for row in samples))
    (source / "manifest.json").write_text(
        json.dumps({"id": "fixture", "state": "captured", "sampling_fps": 10})
    )
    return source, samples


def test_episode_selection_uses_capture_time_and_rejects_bad_bounds(tmp_path):
    _, samples = fixture(tmp_path)
    assert [row["index"] for row in select_samples(samples, {"start_s": 0.2, "end_s": 0.4})] == [2, 3, 4]
    assert len(training_samples(samples, 10)) == 6
    for start, end in [(0.3, 0.1), (-1, 0.5), (0, 400)]:
        with pytest.raises(ValueError, match="interval"):
            select_samples(samples, {"start_s": start, "end_s": end})
    short = [{**samples[0]}, {**samples[1], "time_ms": 1090}]
    with pytest.raises(ValueError, match="after resampling"):
        training_samples(short, 10)
    samples[1]["images"]["workspace"]["monotonic_s"] += 1
    with pytest.raises(ValueError, match="skew"):
        training_samples(samples, 10)


def test_mp4_export_is_decodable_and_does_not_change_originals(tmp_path):
    source, _ = fixture(tmp_path)
    before = (source / "samples.jsonl").read_bytes()
    destination = tmp_path / "export"
    export_selection(
        source,
        destination,
        {"kind": "mp4", "task": "Pick up a white piece", "camera": "both", "speed": 1, "overlay": True},
    )
    with av.open(str(destination / "clip.mp4")) as video:
        frames = list(video.decode(video=0))
    assert len(frames) == 6
    assert (frames[0].width, frames[0].height) == (1280, 576)
    assert (source / "samples.jsonl").read_bytes() == before
    assert json.loads((destination / "episode.json").read_text())["source_frame_indices"] == list(range(6))


def test_training_refuses_incomplete_capture_and_time_warp(tmp_path):
    source, _ = fixture(tmp_path)
    with pytest.raises(ValueError, match="original timing"):
        export_selection(source, tmp_path / "speed", {"kind": "lerobot", "task": "task", "speed": 2})
    path = source / "manifest.json"
    manifest = json.loads(path.read_text())
    manifest["state"] = "incomplete"
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="Incomplete"):
        export_selection(source, tmp_path / "bad", {"kind": "lerobot", "task": "task"})
    with pytest.raises(ValueError, match="image path"):
        image_path(source, "../outside.jpg")
