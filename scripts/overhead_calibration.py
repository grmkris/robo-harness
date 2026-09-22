"""Fit the overhead camera to the mat plane from a recording, using the arm as the ruler.

Every recorded sample carries the tip position from forward kinematics. Where
the tip can be seen in the overhead frame, that gives a pixel <-> metres pair
on one plane, and enough pairs across the mat fix a homography. No target, no
checkerboard: the arm calibrates the camera by moving.

    python scripts/overhead_calibration.py <recording dir> --out var/overhead-calibration.json

The tip is found by differencing each frame against a median background, which
only works where the arm moved enough for the median to be arm-free and the
tip sits over something it contrasts with. The fit refuses to write unless the
coverage and residuals clear the bars below; a calibration that failed those
is worse than none, because the search would trust it. Coverage is measured
along the points' own principal axes, so an arc sweep is judged on how much
mat it actually crossed rather than on how it happens to lie against x and y.

Also finds the piece in the background: the bright blob with a dark surround.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage, spatial

SCALE = 2  # analyse at 320x240; pixels are reported at full resolution
DIFF_THRESHOLD = 40
MIN_ARM_PIXELS = 150
INLIER_M = 0.012
MIN_SPAN_M = 0.15
# Points on one line fix no plane however far apart they are, so the fit also needs
# spread across the sweep. An arc's own width is its sagitta, which is small but real.
MIN_MINOR_SPAN_M = 0.03
# Two points define a direction but no spread, so a shorter set has no extent to measure.
MIN_SPREAD_POINTS = 2
# A homography is only measured where points were seen. Off that region it
# extrapolates, and an arc sweep is thin: on 2026-09-18 a fit whose residuals
# were 5.5 mm on its own inliers placed the piece at r = 0.166 m while two
# photographs put the mat's near edge past 0.22 m. A position this far outside
# the swept region is reported, never used.
MAX_EXTRAPOLATION_PX = 12.0
# A hull needs three points; fewer describes no region to be inside of.
MIN_HULL_POINTS = 3
MIN_INLIER_FRACTION = 0.6
MAX_P90_M = 0.010
RANSAC_ROUNDS = 3000
MIN_FRAMES = 20
MIN_DETECTIONS = 8
# The piece: a bright blob of a plausible size, surrounded by dark mat.
BRIGHT = 170
DARK_MAT = 80
DARK_SURROUND = 90
PIECE_MIN_PX, PIECE_MAX_PX = 8, 80
# A homogeneous coordinate this close to zero is a point at infinity.
DEGENERATE_W = 1e-12


def load_gray(path: Path) -> np.ndarray:
    img = Image.open(path).convert("L")
    img = img.resize((img.width // SCALE, img.height // SCALE), Image.BILINEAR)
    return np.asarray(img, dtype=np.float32)


def normalise(points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    centre = points.mean(axis=0)
    scale = np.sqrt(2) / max(1e-9, np.mean(np.linalg.norm(points - centre, axis=1)))
    transform = np.array([[scale, 0, -scale * centre[0]], [0, scale, -scale * centre[1]], [0, 0, 1]])
    homogeneous = np.c_[points, np.ones(len(points))]
    return (transform @ homogeneous.T).T, transform


def dlt(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Direct linear transform with Hartley normalisation."""
    s, ts = normalise(src)
    d, td = normalise(dst)
    rows = []
    for (x, y, _), (u, v, _) in zip(s, d, strict=True):
        rows.append([-x, -y, -1, 0, 0, 0, u * x, u * y, u])
        rows.append([0, 0, 0, -x, -y, -1, v * x, v * y, v])
    _, _, vt = np.linalg.svd(np.array(rows))
    return np.linalg.inv(td) @ vt[-1].reshape(3, 3) @ ts


def coverage_spread(points: np.ndarray) -> tuple[float, float]:
    """Extent of a point set along its own principal axes, in metres (major, minor).

    Axis-aligned extents measure the camera's orientation as much as the sweep's
    coverage: the same arc reads wide or narrow depending only on how it happens to
    lie against x and y, so a serpentine raster of arcs fails an x/y bar by
    construction. Projecting onto the set's own principal axes removes that
    dependence. The minor extent is the one that decides whether a homography is
    determined at all -- collinear points fix no plane however far apart they are.
    """
    if len(points) < MIN_SPREAD_POINTS:
        return 0.0, 0.0
    finite = points[np.isfinite(points).all(axis=1)]
    if len(finite) < MIN_SPREAD_POINTS:
        return 0.0, 0.0
    centred = finite - finite.mean(axis=0)
    _, _, basis = np.linalg.svd(centred, full_matrices=False)
    projected = centred @ basis.T
    return float(np.ptp(projected[:, 0])), float(np.ptp(projected[:, 1]))


def outside_hull_px(hull_points: np.ndarray, point: np.ndarray) -> float | None:
    """How far `point` lies outside the convex hull of `hull_points`, in pixels.

    Zero means inside. None means the question cannot be asked -- too few
    points, or points so nearly collinear that they enclose no area.

    The check is done in pixels, on the region the arm was actually seen in,
    because that is where the homography was measured. Everywhere else it
    extrapolates, and the thin band an arc sweep covers extrapolates badly a
    few centimetres off it.
    """
    if len(hull_points) < MIN_HULL_POINTS:
        return None
    try:
        hull = spatial.ConvexHull(hull_points)
    except spatial.QhullError:
        return None
    # Each facet is A.x + b <= 0 inside; the largest positive value is the
    # distance to the nearest face of the hull, in pixel units.
    equations = hull.equations
    signed = equations[:, :-1] @ point + equations[:, -1]
    return float(max(0.0, signed.max()))


def apply(h: np.ndarray, points: np.ndarray) -> np.ndarray:
    q = (h @ np.c_[points, np.ones(len(points))].T).T
    w = np.where(np.abs(q[:, 2:3]) < DEGENERATE_W, np.nan, q[:, 2:3])
    return q[:, :2] / w


def tip_pixel(frame: np.ndarray, background: np.ndarray) -> tuple[int, int] | None:
    """The most distal pixel of the largest region that differs from the background."""
    diff = ndimage.binary_opening(np.abs(frame - background) > DIFF_THRESHOLD, iterations=1)
    labels, count = ndimage.label(diff)
    if count == 0:
        return None
    sizes = ndimage.sum(diff, labels, range(1, count + 1))
    largest = int(np.argmax(sizes)) + 1
    if sizes[largest - 1] < MIN_ARM_PIXELS:
        return None
    ys, xs = np.nonzero(labels == largest)
    # The arm enters from the top of the frame; the tip is the region's pixel
    # farthest from where it meets the top.
    top = int(np.argmin(ys))
    far = int(np.argmax((xs - xs[top]) ** 2 + (ys - ys[top]) ** 2))
    return int(xs[far]) * SCALE, int(ys[far]) * SCALE


def mat_mask(full: np.ndarray) -> np.ndarray:
    """The mat: the largest dark region, holes filled, edges pulled in so that
    the table beyond the mat edge and the arm above it do not count."""
    dark = ndimage.binary_opening(full < DARK_MAT, iterations=6)
    labels, count = ndimage.label(dark)
    if count == 0:
        return np.zeros_like(dark)
    sizes = ndimage.sum(dark, labels, range(1, count + 1))
    largest = labels == (int(np.argmax(sizes)) + 1)
    return ndimage.binary_erosion(ndimage.binary_fill_holes(largest), iterations=10)


def find_piece(background: np.ndarray) -> dict | None:
    """A bright blob on the mat with a dark surround, at full resolution."""
    full = np.asarray(
        Image.fromarray(background.astype(np.uint8)).resize(
            (background.shape[1] * SCALE, background.shape[0] * SCALE), Image.BILINEAR
        ),
        dtype=np.float32,
    )
    on_mat = mat_mask(full)
    labels, count = ndimage.label(full > BRIGHT)
    best = None
    for index in range(1, count + 1):
        ys, xs = np.nonzero(labels == index)
        w, h = int(np.ptp(xs)) + 1, int(np.ptp(ys)) + 1
        if not (PIECE_MIN_PX <= w <= PIECE_MAX_PX and PIECE_MIN_PX <= h <= PIECE_MAX_PX):
            continue
        cx, cy = float(xs.mean()), float(ys.mean())
        if not on_mat[int(cy), int(cx)]:
            continue
        left, right = int(xs.min()), int(xs.max())
        top, bottom = int(ys.min()), int(ys.max())
        # Dark on every side, and every side inside the frame: a bright patch
        # at the edge of the image is the table beyond the mat, not a piece.
        sides = [
            full[top:bottom, max(0, left - w) : left],
            full[top:bottom, right + 1 : right + 1 + w],
            full[max(0, top - h) : top, left:right],
            full[bottom + 1 : bottom + 1 + h, left:right],
        ]
        if any(side.size < w * h // 2 or side.mean() > DARK_SURROUND for side in sides):
            continue
        surround = float(np.mean([side.mean() for side in sides]))
        candidate = {
            "x": round(cx, 1),
            "y": round(cy, 1),
            "w": w,
            "h": h,
            "surround": round(surround, 1),
        }
        if best is None or candidate["surround"] < best["surround"]:
            best = candidate
    return best


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("recording")
    parser.add_argument("--out", required=True)
    parser.add_argument("--every", type=int, default=2, help="use every Nth sample")
    parser.add_argument("--force", action="store_true", help="write even when the fit fails its bars")
    args = parser.parse_args()
    recording = Path(args.recording)
    samples = [json.loads(line) for line in (recording / "samples.jsonl").open()][:: args.every]

    frames, tips_m, seen = [], [], set()
    for sample in samples:
        image = sample["images"].get("workspace")
        if not image or image["id"] in seen:
            continue
        seen.add(image["id"])
        frames.append(load_gray(recording / image["path"]))
        tips_m.append(sample["observation"]["ee"][:2])
    if len(frames) < MIN_FRAMES:
        raise SystemExit(f"only {len(frames)} distinct overhead frames; need at least {MIN_FRAMES}")
    stack = np.stack(frames)
    background = np.median(stack, axis=0)

    pixels, metres = [], []
    for frame, xy in zip(stack, tips_m, strict=True):
        found = tip_pixel(frame, background)
        if found is not None:
            pixels.append(found)
            metres.append(xy)
    pixels_a = np.array(pixels, dtype=np.float64)
    metres_a = np.array(metres, dtype=np.float64)
    if len(pixels_a) < MIN_DETECTIONS:
        raise SystemExit(f"only {len(pixels_a)} tip detections; nothing to fit")

    rng = np.random.default_rng(0)
    best_inliers = None
    for _ in range(RANSAC_ROUNDS):
        idx = rng.choice(len(pixels_a), 4, replace=False)
        try:
            h = dlt(pixels_a[idx], metres_a[idx])
        except np.linalg.LinAlgError:
            continue
        err = np.nan_to_num(np.linalg.norm(apply(h, pixels_a) - metres_a, axis=1), nan=1e9)
        inliers = err < INLIER_M
        if best_inliers is None or inliers.sum() > best_inliers.sum():
            best_inliers = inliers
    assert best_inliers is not None
    h = dlt(pixels_a[best_inliers], metres_a[best_inliers])
    err = np.nan_to_num(np.linalg.norm(apply(h, pixels_a) - metres_a, axis=1), nan=1e9)
    inliers = err < INLIER_M
    spread_major, spread_minor = coverage_spread(metres_a[inliers]) if inliers.any() else (0.0, 0.0)
    fit = {
        "detections": len(pixels_a),
        "inliers": int(inliers.sum()),
        "inlier_fraction": round(float(inliers.mean()), 3),
        "residual_p50_mm": round(float(np.median(err[inliers]) * 1000), 1) if inliers.any() else None,
        "residual_p90_mm": round(float(np.percentile(err[inliers], 90) * 1000), 1) if inliers.any() else None,
        "spread_major_m": round(spread_major, 3),
        "spread_minor_m": round(spread_minor, 3),
    }
    bars = {
        "inlier_fraction": fit["inlier_fraction"] >= MIN_INLIER_FRACTION,
        "residual_p90": fit["residual_p90_mm"] is not None and fit["residual_p90_mm"] <= MAX_P90_M * 1000,
        "spread_major": fit["spread_major_m"] >= MIN_SPAN_M,
        "spread_minor": fit["spread_minor_m"] >= MIN_MINOR_SPAN_M,
    }
    piece = find_piece(background)
    # The piece is generally not on the swept arc, so its position is only
    # trustworthy if it falls inside the region the fit was measured in.
    outside_px = (
        outside_hull_px(pixels_a[inliers], np.array([piece["x"], piece["y"]]))
        if piece and inliers.any()
        else None
    )
    extrapolated = outside_px is None or outside_px > MAX_EXTRAPOLATION_PX
    piece_xy = (
        apply(h, np.array([[piece["x"], piece["y"]]]))[0].tolist() if piece and not extrapolated else None
    )
    report = {
        "recording": recording.name,
        "camera": "workspace",
        "plane": "tip height of the recorded sweep (FK ee z)",
        "pixel_to_metres": h.tolist(),
        "fit": fit,
        "bars": bars,
        "accepted": all(bars.values()),
        "piece_pixel": piece,
        "piece_xy_m": [round(v, 3) for v in piece_xy] if piece_xy else None,
        # Why there is no position, when there is a piece but no coordinates.
        "piece_outside_sweep_px": (None if outside_px is None else round(outside_px, 1)),
        "piece_extrapolated": bool(piece) and extrapolated,
    }
    print(json.dumps({k: v for k, v in report.items() if k != "pixel_to_metres"}, indent=2))
    if piece and extrapolated:
        where = "no region to test against" if outside_px is None else f"{outside_px:.0f} px outside it"
        print(
            f"piece found at ({piece['x']:.0f}, {piece['y']:.0f}) but not positioned: "
            f"the fit was measured over the swept arc and the piece is {where}. "
            "Sweep over the piece, or move it into the swept region.",
            file=sys.stderr,
        )
    if report["accepted"] or args.force:
        Path(args.out).write_text(json.dumps(report, indent=2) + "\n")
        print(f"written {args.out}", file=sys.stderr)
    else:
        failed = [name for name, ok in bars.items() if not ok]
        print(f"not written: failed {', '.join(failed)}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
