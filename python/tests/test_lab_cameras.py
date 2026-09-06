import base64
import sys
import time
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient
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
    import robo_harness.service as service

    events = []
    monkeypatch.setattr(service, "Kinematics", lambda *args: object())
    monkeypatch.setattr(
        service, "Cameras", lambda *args: SimpleNamespace(close=lambda: events.append("closed"))
    )

    def fail(profile):
        raise ValueError("Calibration mismatch")

    monkeypatch.setattr(service, "LeRobotDriver", fail)
    with pytest.raises(ValueError, match="Calibration mismatch"):
        with TestClient(create_app({"backend": "so101", "urdf": "unused"}, "a-test-credential-long-enough")):
            pass
    assert events == ["closed"]
