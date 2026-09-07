import base64
import sys
import threading
import time
from collections import OrderedDict
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient
from robo_harness import service
from robo_harness.cameras import Cameras
from robo_harness.service import create_app


def test_lab_camera_preserves_capture_provenance_without_duplicating_frames(monkeypatch):
    stamp = time.monotonic()
    source = SimpleNamespace(
        seq=137,
        mono_ts=stamp,
        wall_ts=time.time(),
        bgr=np.zeros((2, 3, 3)),
        repeat=False,
        jpeg=lambda quality: b"original-jpeg",
    )

    class Owner:
        closed = False

        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def latest(self, name, max_age_ms):
            return source

        def close(self):
            self.closed = True

    monkeypatch.setitem(sys.modules, "lab_cameras", SimpleNamespace(CameraOwner=Owner))
    cameras = Cameras({"camera_mode": "lab", "camera_devices": {}}, "device-boot")
    try:
        deadline = time.monotonic() + 2
        while cameras.status()["workspace"]["seq"] != 137:
            assert time.monotonic() < deadline
            time.sleep(0.01)
        frame = cameras.get("workspace")
        assert frame["id"] == "device-boot:workspace:137"
        assert frame["monotonic_s"] == stamp
        assert frame["wall_time_ms"] == source.wall_ts * 1000
        assert (frame["width"], frame["height"]) == (3, 2)
        assert base64.b64decode(frame["base64"]) == b"original-jpeg"
        time.sleep(0.06)
        assert cameras.get("workspace")["seq"] == 137
        assert len([f for f in cameras.history.values() if f["camera"] == "workspace"]) == 1
    finally:
        cameras.close()
    assert cameras.owner.closed


def test_motor_startup_failure_releases_camera_ownership(monkeypatch):
    events = []
    monkeypatch.setattr(service, "Kinematics", lambda *args: object())
    monkeypatch.setattr(
        service, "Cameras", lambda *args: SimpleNamespace(close=lambda: events.append("closed"))
    )

    def fail(profile):
        raise ValueError("Calibration mismatch")

    monkeypatch.setattr(service, "LeRobotDriver", fail)
    with (
        pytest.raises(ValueError, match="Calibration mismatch"),
        TestClient(create_app({"backend": "so101", "urdf": "unused"}, "a-test-credential-long-enough")),
    ):
        pass
    assert events == ["closed"]


def test_device_camera_read_failure_recovers(monkeypatch):
    """A read failure in `devices` mode must not kill the capture thread: it
    drops the handle, reopens, and resumes producing frames."""
    mjpg = ord("M") | (ord("J") << 8) | (ord("P") << 16) | (ord("G") << 24)
    reads = {"n": 0}
    opened = []

    class FakeCap:
        def __init__(self):
            self.released = False

        def set(self, *args):
            return True

        def get(self, prop):
            return mjpg

        def isOpened(self):
            return True

        def read(self):
            reads["n"] += 1
            if reads["n"] <= 2:  # first two reads fail, then it recovers
                return (False, None)
            return (True, np.zeros((4, 4, 3), dtype=np.uint8))

        def release(self):
            self.released = True

    def video_capture(dev, backend):
        cap = FakeCap()
        opened.append(cap)
        return cap

    fake_cv2 = SimpleNamespace(
        VideoCapture=video_capture,
        VideoWriter_fourcc=lambda *cc: mjpg,
        cvtColor=lambda bgr, code: bgr,
        CAP_V4L2=0,
        CAP_PROP_FOURCC=0,
        CAP_PROP_FRAME_WIDTH=0,
        CAP_PROP_FRAME_HEIGHT=0,
        CAP_PROP_FPS=0,
        COLOR_BGR2RGB=0,
    )
    monkeypatch.setitem(sys.modules, "cv2", fake_cv2)

    # Build a Cameras without __init__, so no flock/lock file or auto threads.
    cams = Cameras.__new__(Cameras)
    cams.profile = {"camera_mode": "devices", "camera_devices": {"workspace": "/dev/cam"}}
    cams.domain = "boot"
    cams.lock = threading.Lock()
    cams.frames, cams.history, cams.errors = {}, OrderedDict(), {}
    cams.closed = threading.Event()
    cams.seq = {"workspace": 0}
    cams.owner = None

    worker = threading.Thread(target=cams._capture, args=("workspace",), daemon=True)
    worker.start()
    try:
        deadline = time.monotonic() + 8
        while cams.seq["workspace"] == 0:
            assert time.monotonic() < deadline, f"never recovered: {cams.errors}"
            time.sleep(0.05)
    finally:
        cams.closed.set()
        worker.join(timeout=3)

    assert reads["n"] >= 3, "should have retried past the failing reads"
    assert len(opened) >= 2, "should have reopened the device after a read failure"
    assert cams.get("workspace")["camera"] == "workspace"
    assert "workspace" not in cams.errors  # cleared once a frame succeeded
