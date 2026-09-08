"""Offline fixed-camera/table-plane calibration. Produces evidence, never motor commands."""

import argparse
import base64
import hashlib
import io
import json
import sys
from datetime import UTC, datetime
from html import escape
from pathlib import Path
from typing import Annotated, Literal, Self

import numpy as np
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from scipy.spatial import ConvexHull, QhullError

Finite = Annotated[float, Field(allow_inf_nan=False)]
Positive = Annotated[Finite, Field(gt=0)]
Name = Annotated[str, Field(min_length=1, max_length=200)]
Pair = tuple[Finite, Finite]
ImageSize = Annotated[int, Field(gt=0, le=16384)]
MIN_FIT_POINTS = 6
MIN_CHECK_POINTS = 3
# Normalized DLT must constrain eight independent homography parameters.
HOMOGRAPHY_RANK = 8
MAX_CONDITION = 1e8
EPS = 1e-10
# Keep a full text line visible above labels near the image edge.
LABEL_MIN_Y = 24


class Document(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class CameraSetup(Document):
    camera: Literal["workspace"]
    setup_id: Name
    width: ImageSize
    height: ImageSize
    coordinate_frame: Name
    plane_z_m: Finite


class SavedFrame(BaseModel):
    # Decode consumed capture fields; the runtime Frame also carries timing and telemetry metadata.
    model_config = ConfigDict(extra="ignore", strict=True)
    id: Name
    camera: Literal["workspace"]
    width: ImageSize
    height: ImageSize
    base64: Annotated[str, Field(min_length=1)]


class ReferenceImage(Document):
    frame_id: Name
    sha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class Measurement(Document):
    id: Name
    split: Literal["fit", "check"]
    uv: Pair
    xy_m: Pair


class Measurements(Document):
    version: Literal[1]
    kind: Literal["tabletop_measurements"]
    setup: CameraSetup
    image: ReferenceImage
    points: Annotated[list[Measurement], Field(min_length=MIN_CHECK_POINTS, max_length=1000)]

    @model_validator(mode="after")
    def validate_points(self) -> Self:
        if len({p.id for p in self.points}) != len(self.points):
            raise ValueError("Point IDs must be unique")
        for field in ("uv", "xy_m"):
            values = np.array([getattr(p, field) for p in self.points])
            for i, value in enumerate(values):
                if np.any(np.linalg.norm(values[:i] - value, axis=1) < EPS):
                    raise ValueError(f"Duplicate {field}: fit and check points must be independent")
        if any(
            not (0 <= p.uv[0] < self.setup.width and 0 <= p.uv[1] < self.setup.height) for p in self.points
        ):
            raise ValueError("Point pixels must be inside the unmodified reference image")
        return self


class Calibration(Document):
    version: Literal[1]
    kind: Literal["tabletop_calibration"]
    id: Name
    created_at: str
    measurements: Measurements
    max_error_mm: Positive
    # Deliberately no intrinsics/extrinsics or commissioned flag: one plane cannot establish them.


def read_measurements(path: Path) -> Measurements:
    return Measurements.model_validate_json(path.read_text())


def project(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    homogeneous = np.column_stack((points, np.ones(len(points)))) @ matrix.T
    if not np.all(np.isfinite(homogeneous)) or np.any(np.abs(homogeneous[:, 2]) < EPS):
        raise ValueError("Projection reaches the homography horizon")
    return homogeneous[:, :2] / homogeneous[:, 2:3]


def _normalize(points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    center = points.mean(axis=0)
    distance = np.linalg.norm(points - center, axis=1).mean()
    if distance < EPS:
        raise ValueError("Reference points have no usable spread")
    scale = np.sqrt(2) / distance
    transform = np.array([[scale, 0, -scale * center[0]], [0, scale, -scale * center[1]], [0, 0, 1]])
    return project(transform, points), transform


def fit_homography(uv: np.ndarray, xy: np.ndarray) -> np.ndarray:
    """Normalized DLT; retain all labelled points so outliers remain visible in the report."""
    source, ts = _normalize(uv)
    target, tt = _normalize(xy)
    rows = []
    for (u, v), (x, y) in zip(source, target, strict=True):
        rows.extend(([-u, -v, -1, 0, 0, 0, x * u, x * v, x], [0, 0, 0, -u, -v, -1, y * u, y * v, y]))
    _, singular, vt = np.linalg.svd(np.array(rows), full_matrices=False)
    if (
        len(singular) < HOMOGRAPHY_RANK
        or singular[0] / max(singular[HOMOGRAPHY_RANK - 1], EPS) > MAX_CONDITION
    ):
        raise ValueError("Reference points are collinear or too poorly distributed to fit a plane")
    matrix = np.linalg.inv(tt) @ vt[-1].reshape(3, 3) @ ts
    matrix /= np.linalg.norm(matrix)
    if np.linalg.cond(matrix) > MAX_CONDITION:
        raise ValueError("Fitted homography is singular or unstable")
    denominators = np.column_stack((uv, np.ones(len(uv)))) @ matrix[2]
    if np.min(denominators) <= EPS and np.max(denominators) >= -EPS:
        raise ValueError("Fitted homography crosses the reference region's horizon")
    return matrix


def inside_reference_region(reference: np.ndarray, points: np.ndarray) -> np.ndarray:
    try:
        hull = ConvexHull(reference)
    except QhullError as error:
        raise ValueError("Reference points must cover a two-dimensional region") from error
    return np.all(points @ hull.equations[:, :2].T + hull.equations[:, 2] <= EPS, axis=1)


def _arrays(points: list[Measurement]) -> tuple[np.ndarray, np.ndarray]:
    return np.array([p.uv for p in points]), np.array([p.xy_m for p in points])


def fitted_matrix(data: Measurements) -> np.ndarray:
    fit = [p for p in data.points if p.split == "fit"]
    check = [p for p in data.points if p.split == "check"]
    if len(fit) < MIN_FIT_POINTS or len(check) < MIN_CHECK_POINTS:
        raise ValueError("Use at least six fit points and three separate check points")
    uv, xy = _arrays(fit)
    check_uv, check_xy = _arrays(check)
    if not np.all(inside_reference_region(uv, check_uv)) or not np.all(inside_reference_region(xy, check_xy)):
        raise ValueError("Check points must be inside the fit points' covered region in pixels and metres")
    inside_reference_region(check_xy, check_xy)  # Reject collinear check layouts, too.
    return fit_homography(uv, xy)


def _metrics(errors: np.ndarray) -> dict:
    return {
        "count": len(errors),
        "rmse_mm": float(np.sqrt(np.mean(errors**2))),
        "max_error_mm": float(np.max(errors)),
    }


def evaluate(calibration: Calibration, data: Measurements) -> dict:
    source = calibration.measurements
    if data.setup != source.setup:
        raise ValueError("Camera setup, image size, coordinate frame or plane differs from calibration")
    matrix = fitted_matrix(source)
    fit_points = [p for p in source.points if p.split == "fit"]
    fit_uv, fit_xy = _arrays(fit_points)
    if data != source:
        if any(p.split != "check" for p in data.points):
            raise ValueError("A new evaluation set must contain only check points")
        for p in data.points:
            if np.any(np.linalg.norm(fit_xy - p.xy_m, axis=1) < EPS):
                raise ValueError("Evaluation reuses a fit target; use held-out physical positions")
        check_uv, check_xy = _arrays(data.points)
        if not np.all(inside_reference_region(fit_uv, check_uv)) or not np.all(
            inside_reference_region(fit_xy, check_xy)
        ):
            raise ValueError("Evaluation points are outside the reference region")
        inside_reference_region(check_xy, check_xy)
    uv, xy = _arrays(data.points)
    predicted = project(matrix, uv)
    pixel_projection = project(np.linalg.inv(matrix), xy)
    errors = np.linalg.norm(predicted - xy, axis=1) * 1000
    fit_errors = np.linalg.norm(project(matrix, fit_uv) - fit_xy, axis=1) * 1000
    check_errors = errors[[p.split == "check" for p in data.points]]
    reference_uv, reference_xy = _arrays([p for p in source.points if p.split == "check"])
    reference_errors = np.linalg.norm(project(matrix, reference_uv) - reference_xy, axis=1) * 1000
    within = bool(
        np.max(fit_errors) <= calibration.max_error_mm
        and np.max(reference_errors) <= calibration.max_error_mm
        and np.max(check_errors) <= calibration.max_error_mm
    )
    return {
        "version": 1,
        "kind": "tabletop_evaluation",
        "calibration_id": calibration.id,
        "reference_frame_id": data.image.frame_id,
        "setup": data.setup.model_dump(mode="json"),
        "status": "within_tolerance" if within else "outside_tolerance",
        "max_error_mm": calibration.max_error_mm,
        "scope": "Offline evidence for this fixed camera and plane; not motion authorization or a depth sensor.",
        "fit": _metrics(fit_errors),
        "reference_check": _metrics(reference_errors),
        "check": _metrics(check_errors),
        "image_to_plane": matrix.tolist(),
        "points": [
            {
                "id": p.id,
                "split": p.split,
                "uv": p.uv,
                "xy_m": p.xy_m,
                "predicted_xy_m": predicted[i].tolist(),
                "projected_uv": pixel_projection[i].tolist(),
                "error_mm": float(errors[i]),
            }
            for i, p in enumerate(data.points)
        ],
    }


def load_image(path: Path, data: Measurements) -> tuple[bytes, str]:
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != data.image.sha256:
        raise ValueError("Image hash does not match measurements; use the original, unmodified frame")
    with Image.open(io.BytesIO(raw)) as image:
        if image.size != (data.setup.width, data.setup.height):
            raise ValueError("Image size does not match measurements")
        if image.format not in ("JPEG", "PNG"):
            raise ValueError("Reference image must be JPEG or PNG")
        mime = "image/jpeg" if image.format == "JPEG" else "image/png"
        image.verify()
    return raw, mime


def overlay_svg(data: Measurements, report: dict, raw: bytes, mime: str) -> str:
    width, height = data.setup.width, data.setup.height
    footer = 122
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height + footer}" viewBox="0 0 {width} {height + footer}">',
        "<title>Tabletop calibration residuals</title>",
        '<rect width="100%" height="100%" fill="#111827"/>',
        f'<image width="{width}" height="{height}" href="data:{mime};base64,{base64.b64encode(raw).decode()}"/>',
        '<g font-family="monospace" font-size="12" stroke-width="2">',
    ]
    for p in report["points"]:
        u, v = p["uv"]
        pu, pv = p["projected_uv"]
        color = "#67e8f9" if p["split"] == "fit" else "#fde047"
        label_x, anchor = (u + 8, "start") if u < width / 2 else (u - 8, "end")
        label_y = v - 8 if v > LABEL_MIN_Y else v + 20
        parts.extend(
            (
                f'<circle cx="{u}" cy="{v}" r="5" fill="none" stroke="{color}"/>',
                f'<path d="M {u} {v} L {pu} {pv} M {pu - 4} {pv} H {pu + 4} M {pu} {pv - 4} V {pv + 4}" stroke="{color}" fill="none"/>',
                f'<text x="{label_x}" y="{label_y}" text-anchor="{anchor}" fill="{color}" paint-order="stroke" stroke="#111827" stroke-width="3">{escape(p["id"])} · {p["error_mm"]:.2f} mm</text>',
            )
        )
    lines = [
        f"{report['status']} | check max {report['check']['max_error_mm']:.2f} mm / limit {report['max_error_mm']:g} mm",
        f"Original check max {report['reference_check']['max_error_mm']:.2f} mm | fit max {report['fit']['max_error_mm']:.2f} mm",
        "Cyan: fit. Yellow: held-out. Circle: labelled. Cross: projected.",
        "Fixed camera / reference plane only. Offline evidence; not commissioned.",
        f"{data.setup.coordinate_frame} | {data.setup.setup_id}",
    ]
    for i, line in enumerate(lines):
        parts.append(f'<text x="10" y="{height + 20 + i * 22}" fill="#f3f4f6">{escape(line)}</text>')
    return "\n".join([*parts, "</g></svg>"])


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def prepare(frame_path: Path, output: Path, setup_id: str, coordinate_frame: str, plane_z_m: float) -> None:
    frame = SavedFrame.model_validate_json(frame_path.read_text())
    setup = CameraSetup.model_validate(
        {
            "camera": frame.camera,
            "width": frame.width,
            "height": frame.height,
            "setup_id": setup_id,
            "coordinate_frame": coordinate_frame,
            "plane_z_m": plane_z_m,
        }
    )
    raw = base64.b64decode(frame.base64, validate=True)
    reference = ReferenceImage(frame_id=frame.id, sha256=hashlib.sha256(raw).hexdigest())
    with Image.open(io.BytesIO(raw)) as image:
        if image.size != (setup.width, setup.height) or image.format not in ("JPEG", "PNG"):
            raise ValueError("Capture image dimensions/format do not match metadata")
        suffix = "jpg" if image.format == "JPEG" else "png"
        image.verify()
    output.mkdir(parents=True, exist_ok=False)
    (output / f"frame.{suffix}").write_bytes(raw)
    write_json(
        output / "measurements.json",
        {
            "version": 1,
            "kind": "tabletop_measurements",
            "setup": setup.model_dump(mode="json"),
            "image": reference.model_dump(mode="json"),
            "points": [
                {"id": f"{split}-{i + 1}", "split": split, "uv": None, "xy_m": None}
                for split, count in (("fit", MIN_FIT_POINTS), ("check", MIN_CHECK_POINTS))
                for i in range(count)
            ],
        },
    )


def run_fit(data_path: Path, image_path: Path, output: Path, max_error_mm: float) -> dict:
    data = read_measurements(data_path)
    identity = {"measurements": data.model_dump(mode="json"), "max_error_mm": max_error_mm}
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, allow_nan=False).encode()).hexdigest()
    calibration = Calibration(
        version=1,
        kind="tabletop_calibration",
        id=f"tabletop-{digest[:24]}",
        created_at=datetime.now(UTC).isoformat(),
        measurements=data,
        max_error_mm=max_error_mm,
    )
    report = evaluate(calibration, data)
    raw, mime = load_image(image_path, data)
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "calibration.json", calibration.model_dump(mode="json"))
    write_json(output / "evaluation.json", report)
    (output / "overlay.svg").write_text(overlay_svg(data, report, raw, mime))
    return report


def run_evaluate(calibration_path: Path, data_path: Path, image_path: Path, output: Path) -> dict:
    calibration = Calibration.model_validate_json(calibration_path.read_text())
    data = read_measurements(data_path)
    report = evaluate(calibration, data)
    raw, mime = load_image(image_path, data)
    output.mkdir(parents=True, exist_ok=False)
    write_json(output / "evaluation.json", report)
    (output / "overlay.svg").write_text(overlay_svg(data, report, raw, mime))
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser(
        "prepare", help="Unpack a saved workspace capture and create a measurement template"
    )
    prep.add_argument("frame", type=Path)
    prep.add_argument("--setup-id", required=True)
    prep.add_argument("--coordinate-frame", required=True)
    prep.add_argument("--plane-z-m", type=float, required=True)
    prep.add_argument("--output", type=Path, required=True)
    fit = commands.add_parser("fit", help="Fit a table plane and score held-out measurements")
    fit.add_argument("measurements", type=Path)
    fit.add_argument(
        "--max-error-mm", type=float, required=True, help="Explicit task tolerance, not a certified accuracy"
    )
    check = commands.add_parser("evaluate", help="Score new recorded measurements without refitting")
    check.add_argument("calibration", type=Path)
    check.add_argument("measurements", type=Path)
    for command in (fit, check):
        command.add_argument("--image", type=Path, required=True)
        command.add_argument(
            "--output", type=Path, required=True, help="New directory; existing evidence is never overwritten"
        )
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            prepare(args.frame, args.output, args.setup_id, args.coordinate_frame, args.plane_z_m)
            sys.stdout.write(
                f"Prepared {args.output}/measurements.json; fill pixels and measured metres before fitting.\n"
            )
            return
        if args.command == "fit":
            report = run_fit(args.measurements, args.image, args.output, args.max_error_mm)
        else:
            report = run_evaluate(args.calibration, args.measurements, args.image, args.output)
    except ValidationError as error:
        # ValidationError's default string embeds inputs; report field locations and reasons only.
        details = "; ".join(
            f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in error.errors(include_input=False)
        )
        parser.exit(2, f"Invalid calibration data: {details}\n")
    except (ValueError, KeyError, OSError, np.linalg.LinAlgError) as error:
        parser.exit(2, f"Calibration failed: {error}\n")
    sys.stdout.write(
        json.dumps(
            {
                "status": report["status"],
                "fit": report["fit"],
                "reference_check": report["reference_check"],
                "check": report["check"],
                "output": str(args.output),
            }
        )
        + "\n"
    )
    if report["status"] != "within_tolerance":
        sys.exit(1)


if __name__ == "__main__":
    main()
