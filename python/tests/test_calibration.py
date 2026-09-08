"""Independent projective geometry, held-out accuracy, and CLI evidence tests."""

import base64
import hashlib
import io
import json
import subprocess
import sys

import numpy as np
import pytest
from PIL import Image
from pydantic import ValidationError
from robo_harness.calibration import (
    Calibration,
    Measurements,
    evaluate,
    fitted_matrix,
    prepare,
    project,
    run_evaluate,
    run_fit,
)


def world(u, v):
    # Analytic reference camera with perspective, shear and a nonzero origin.
    denominator = 1 + 0.0002 * u - 0.0001 * v
    return [(0.0006 * u + 0.00003 * v + 0.1) / denominator, (-0.00004 * u + 0.0007 * v - 0.2) / denominator]


@pytest.fixture
def scene(tmp_path):
    buffer = io.BytesIO()
    Image.new("RGB", (640, 480), (35, 45, 50)).save(buffer, format="JPEG")
    raw = buffer.getvalue()
    image = tmp_path / "frame.jpg"
    image.write_bytes(raw)
    data = {
        "version": 1,
        "kind": "tabletop_measurements",
        "setup": {
            "camera": "workspace",
            "setup_id": "test-mount-v1",
            "width": 640,
            "height": 480,
            "coordinate_frame": "test_board",
            "plane_z_m": 0.0,
        },
        "image": {"frame_id": "synthetic:workspace:1", "sha256": hashlib.sha256(raw).hexdigest()},
        "points": [
            {"id": f"{split}-{i}", "split": split, "uv": [u, v], "xy_m": world(u, v)}
            for split, points in (
                ("fit", [(40, 40), (590, 40), (590, 430), (40, 430), (315, 40), (315, 430)]),
                ("check", [(200, 160), (440, 175), (320, 340)]),
            )
            for i, (u, v) in enumerate(points)
        ],
    }
    return data, image


def document(data):
    return Measurements.model_validate_json(json.dumps(data))


def saved(path, data):
    path.write_text(json.dumps(data))
    return path


def fitted(scene, tmp_path):
    data, image = scene
    run_fit(saved(tmp_path / "points.json", data), image, tmp_path / "fit", 5)
    path = tmp_path / "fit/calibration.json"
    return path, Calibration.model_validate_json(path.read_text())


def test_recovers_metric_positions_under_perspective(scene):
    data, _ = scene
    matrix = fitted_matrix(document(data))
    unseen = np.array([[175, 240], [440, 320], [210, 80]])
    np.testing.assert_allclose(project(matrix, unseen), [world(u, v) for u, v in unseen], atol=1e-10)


def test_held_out_error_cannot_be_hidden_by_exact_training_fit(scene, tmp_path):
    data, image = scene
    data["points"][-1]["xy_m"][0] += 0.012
    report = run_fit(saved(tmp_path / "points.json", data), image, tmp_path / "fit", 5)
    assert report["fit"]["max_error_mm"] < 1e-8
    assert report["check"]["max_error_mm"] == pytest.approx(12)
    assert report["status"] == "outside_tolerance"
    assert (tmp_path / "fit/overlay.svg").exists(), "Failures must still leave reviewable evidence"


@pytest.mark.parametrize(
    "field,value",
    [
        ("uv", [640, 100]),
        ("uv", [100, float("nan")]),
        ("xy_m", [float("inf"), 0]),
        ("uv", ["40", 40]),
        ("xy_m", [True, 0]),
    ],
)
def test_measurement_boundary_rejects_invalid_coordinates(scene, field, value):
    data, _ = scene
    data["points"][0][field] = value
    with pytest.raises(ValidationError):
        document(data)


def test_rejects_training_point_relabelled_as_validation(scene):
    data, _ = scene
    data["points"][-1]["xy_m"] = data["points"][0]["xy_m"]
    with pytest.raises(ValidationError, match="independent"):
        document(data)


@pytest.mark.parametrize("failure", ["too_few", "line", "outside", "check_line"])
def test_rejects_unusable_calibration_layout(scene, failure):
    data, _ = scene
    if failure == "too_few":
        data["points"].pop(0)
    if failure == "line":
        for i, p in enumerate(data["points"]):
            p["uv"] = [40 + i * 45, 100]
            p["xy_m"] = world(*p["uv"])
    if failure == "outside":
        data["points"][-1]["uv"] = [5, 5]
        data["points"][-1]["xy_m"] = world(5, 5)
    if failure == "check_line":
        for i, p in enumerate(data["points"][-3:]):
            p["uv"] = [150 + i * 100, 200]
            p["xy_m"] = world(*p["uv"])
    with pytest.raises(ValueError):
        fitted_matrix(document(data))


def test_new_frames_are_scored_without_refitting_and_setup_changes_are_rejected(scene, tmp_path):
    path, calibration = fitted(scene, tmp_path)
    original = path.read_bytes()
    data, image = scene
    data["image"]["frame_id"] = "synthetic:workspace:2"
    data["points"] = data["points"][-3:]
    for p in data["points"]:
        p["uv"][0] += 20  # Camera/pixel drift, ground-truth world positions remain fixed.
    report = run_evaluate(path, saved(tmp_path / "check.json", data), image, tmp_path / "check")
    assert report["status"] == "outside_tolerance"
    assert report["check"]["max_error_mm"] > 5
    assert path.read_bytes() == original
    data["setup"]["setup_id"] = "camera-moved"
    with pytest.raises(ValueError, match="setup"):
        evaluate(calibration, document(data))


@pytest.mark.parametrize(
    "field,value", [("width", 1280), ("coordinate_frame", "base_link"), ("plane_z_m", 0.03)]
)
def test_rejects_geometry_context_mismatch(scene, tmp_path, field, value):
    _, calibration = fitted(scene, tmp_path)
    data, _ = scene
    data["setup"][field] = value
    with pytest.raises(ValueError, match="differs"):
        evaluate(calibration, document(data))


def test_new_evaluation_cannot_reuse_fit_positions(scene, tmp_path):
    _, calibration = fitted(scene, tmp_path)
    data, _ = scene
    data["points"] = data["points"][:3]
    for p in data["points"]:
        p["split"] = "check"
    with pytest.raises(ValueError, match="reuses"):
        evaluate(calibration, document(data))


def test_image_hash_and_dimensions_are_checked_before_writing_output(scene, tmp_path):
    data, image = scene
    points = saved(tmp_path / "points.json", data)
    image.write_bytes(image.read_bytes() + b"changed")
    with pytest.raises(ValueError, match="hash"):
        run_fit(points, image, tmp_path / "wrong-hash", 5)
    assert not (tmp_path / "wrong-hash").exists()
    data["image"]["sha256"] = hashlib.sha256(image.read_bytes()).hexdigest()
    data["setup"]["width"] = 1280
    with pytest.raises(ValueError, match="size"):
        run_fit(saved(points, data), image, tmp_path / "wrong-size", 5)


def test_prepare_keeps_original_image_and_requires_real_measurements(scene, tmp_path):
    data, image = scene
    frame = {
        "id": data["image"]["frame_id"],
        "camera": "workspace",
        "width": 640,
        "height": 480,
        "base64": base64.b64encode(image.read_bytes()).decode(),
    }
    capture = saved(tmp_path / "capture.json", frame)
    output = tmp_path / "prepared"
    prepare(capture, output, "test-mount-v1", "test_board", 0)
    assert (output / "frame.jpg").read_bytes() == image.read_bytes()
    with pytest.raises(ValidationError):
        Measurements.model_validate_json((output / "measurements.json").read_text())
    with pytest.raises(FileExistsError):
        prepare(capture, output, "test-mount-v1", "test_board", 0)
    frame["camera"] = "wrist"
    with pytest.raises(ValidationError):
        prepare(saved(capture, frame), tmp_path / "wrist", "test", "test_board", 0)


def test_cli_exit_codes_and_saved_evidence(scene, tmp_path):
    data, image = scene
    points = saved(tmp_path / "points.json", data)

    def invoke(directory):
        return subprocess.run(
            [
                sys.executable,
                "-m",
                "robo_harness.calibration",
                "fit",
                str(points),
                "--image",
                str(image),
                "--max-error-mm",
                "5",
                "--output",
                str(tmp_path / directory),
            ],
            capture_output=True,
            text=True,
            check=False,
        )

    result = invoke("good")
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["status"] == "within_tolerance"
    assert "not commissioned" in (tmp_path / "good/overlay.svg").read_text()
    assert invoke("good").returncode == 2, "Existing evidence must not be overwritten"
    data["points"][-1]["xy_m"][0] += 0.01
    saved(points, data)
    result = invoke("bad")
    assert result.returncode == 1, result.stderr
    assert json.loads(result.stdout)["status"] == "outside_tolerance"


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {"error": "Camera unavailable"},
        {
            "id": "test",
            "camera": "workspace",
            "width": 640,
            "height": 480,
            "base64": 42,
        },
    ],
)
def test_prepare_decodes_capture_boundary_before_creating_files(tmp_path, payload):
    output = tmp_path / "prepared"
    with pytest.raises(ValidationError):
        prepare(saved(tmp_path / "capture.json", payload), output, "test", "board", 0)
    assert not output.exists()


def test_new_evaluation_cannot_hide_a_failed_reference_check(scene, tmp_path):
    data, _ = scene
    data["points"][-1]["xy_m"][0] += 0.012
    _, calibration = fitted(scene, tmp_path)
    data["points"] = [
        {"id": f"new-{i}", "split": "check", "uv": [u, v], "xy_m": world(u, v)}
        for i, (u, v) in enumerate([(180, 200), (450, 320), (200, 80)])
    ]
    report = evaluate(calibration, document(data))
    assert report["check"]["max_error_mm"] < 1e-8
    assert report["reference_check"]["max_error_mm"] == pytest.approx(12)
    assert report["status"] == "outside_tolerance"
