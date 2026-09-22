"""The coverage bar must judge a sweep on the mat it crossed, not on its heading.

The search sweeps serpentine arcs, so every real calibration recording is arc
shaped. An axis-aligned coverage bar rejects those by construction, which is
why the 2026-09-18 recordings could not be fitted even where the geometry was
good. These tests pin the orientation-free measure and the degenerate case it
still has to catch.
"""

import numpy as np
import pytest
from overhead_calibration import (
    MAX_EXTRAPOLATION_PX,
    MIN_MINOR_SPAN_M,
    MIN_SPAN_M,
    coverage_spread,
    outside_hull_px,
)


def arc(radius: float = 0.2, span_deg: float = 90.0, heading_deg: float = 0.0, n: int = 60) -> np.ndarray:
    """Points on a sweep arc, like one pass of the search raster."""
    half = np.radians(span_deg) / 2
    angles = np.linspace(-half, half, n) + np.radians(heading_deg)
    return np.column_stack([radius * np.cos(angles), radius * np.sin(angles)])


def test_an_arc_clears_the_coverage_bar_at_every_heading() -> None:
    # The same arc rotated is the same coverage; an x/y bar would disagree.
    for heading in (0.0, 30.0, 45.0, 90.0, 135.0):
        major, minor = coverage_spread(arc(heading_deg=heading))
        assert major >= MIN_SPAN_M, f"heading {heading}: major {major}"
        assert minor >= MIN_MINOR_SPAN_M, f"heading {heading}: minor {minor}"


def test_the_measure_does_not_depend_on_heading() -> None:
    spreads = [coverage_spread(arc(heading_deg=h)) for h in (0.0, 17.0, 45.0, 90.0)]
    majors = [s[0] for s in spreads]
    minors = [s[1] for s in spreads]
    assert max(majors) - min(majors) < 1e-9
    assert max(minors) - min(minors) < 1e-9


def test_the_old_axis_aligned_bar_would_have_rejected_this_arc() -> None:
    # Regression witness: the arc the search actually sweeps, measured the old way.
    points = arc(heading_deg=0.0)
    span_x = float(np.ptp(points[:, 0]))
    span_y = float(np.ptp(points[:, 1]))
    assert min(span_x, span_y) < MIN_SPAN_M, "the old bar would have passed; test is no longer a witness"
    major, _ = coverage_spread(points)
    assert major >= MIN_SPAN_M


def test_collinear_points_are_still_refused() -> None:
    # A straight sweep fixes no plane however long it is, so the minor bar must catch it.
    line = np.column_stack([np.linspace(-0.3, 0.3, 40), np.zeros(40)])
    major, minor = coverage_spread(line)
    assert major >= MIN_SPAN_M
    assert minor < MIN_MINOR_SPAN_M


def test_a_tight_cluster_is_refused() -> None:
    rng = np.random.default_rng(0)
    blob = rng.normal(scale=0.005, size=(50, 2))
    major, minor = coverage_spread(blob)
    assert major < MIN_SPAN_M
    assert minor < MIN_MINOR_SPAN_M


def test_degenerate_inputs_do_not_raise() -> None:
    assert coverage_spread(np.zeros((0, 2))) == (0.0, 0.0)
    assert coverage_spread(np.array([[0.1, 0.2]])) == (0.0, 0.0)
    nan_heavy = np.array([[0.0, 0.0], [np.nan, 1.0], [np.inf, 2.0]])
    assert coverage_spread(nan_heavy) == (0.0, 0.0)


def test_a_point_inside_the_swept_region_is_not_extrapolation() -> None:
    swept = np.array([[0.0, 0.0], [100.0, 0.0], [100.0, 100.0], [0.0, 100.0]])
    assert outside_hull_px(swept, np.array([50.0, 50.0])) == 0.0
    assert outside_hull_px(swept, np.array([1.0, 99.0])) == 0.0


def test_a_point_beyond_the_swept_region_reports_how_far() -> None:
    swept = np.array([[0.0, 0.0], [100.0, 0.0], [100.0, 100.0], [0.0, 100.0]])
    assert outside_hull_px(swept, np.array([130.0, 50.0])) == pytest.approx(30.0)
    assert outside_hull_px(swept, np.array([50.0, -5.0])) == pytest.approx(5.0)


def test_an_arc_does_not_enclose_the_mat_it_curves_around() -> None:
    # The real case: the fit is measured on a thin arc, and the piece sits off
    # it. Residuals on the arc say nothing about the position out there.
    swept = arc(radius=0.2, span_deg=90.0) * 1000  # pixels, same shape
    beyond = np.array([0.30 * 1000, 0.0])
    outside = outside_hull_px(swept, beyond)
    assert outside is not None and outside > MAX_EXTRAPOLATION_PX


def test_a_degenerate_sweep_answers_none_rather_than_zero() -> None:
    # Collinear points enclose no area: "inside" is not a question that has an
    # answer, and answering 0.0 would read as "safe to trust".
    line = np.column_stack([np.linspace(0, 100, 10), np.zeros(10)])
    assert outside_hull_px(line, np.array([50.0, 0.0])) is None
    assert outside_hull_px(np.array([[0.0, 0.0], [1.0, 1.0]]), np.array([0.5, 0.5])) is None
