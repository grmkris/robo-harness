import json
import time
from pathlib import Path

from fastapi.testclient import TestClient
from robo_harness.service import create_app

ROOT = Path(__file__).resolve().parents[2]
TOKEN = "test-token-with-more-than-24-characters"


def test_auth_and_schema_and_mock():
    p = json.loads((ROOT / "config/robot.example.json").read_text())
    p["urdf"] = str(ROOT / "assets/so101.urdf")
    with TestClient(create_app(p, TOKEN)) as client:
        assert client.get("/observe").status_code == 401
        headers = {"Authorization": "Bearer " + TOKEN}
        assert client.get("/observe", headers=headers).json()["backend"] == "mock"
        assert (
            client.post("/operations", json={"target": {"gripper": 90}}, headers=headers).status_code == 422
        )
        deadline = time.monotonic() + 3
        while True:
            result = client.post("/control/acquire", json={"owner": "test"}, headers=headers)
            if result.status_code == 200:
                break
            assert result.status_code == 503
            assert time.monotonic() < deadline, "Mock cameras never became ready"
            time.sleep(0.02)
        lease = result.json()
        response = client.post(
            "/operations",
            json={
                "owner": "test",
                "lease_id": lease["lease_id"],
                "request_id": "one",
                "target": {"gripper": 42},
            },
            headers=headers,
        )
        assert response.status_code == 200
        assert response.json()["status"] == "accepted"
        assert client.post("/control/stop", json={}, headers=headers).status_code == 200


def test_real_driver_requires_commissioning():
    import pytest
    from robo_harness.drivers import LeRobotDriver

    with pytest.raises(ValueError, match="commissioned"):
        LeRobotDriver({"commissioned": False})


def test_leader_connect_does_not_block_observe(monkeypatch):
    """Connecting a leader must not hold engine.lock: /observe stays responsive
    while the (blocking) serial connect is in progress."""
    import threading

    from robo_harness.drivers import MockDriver

    started = threading.Event()
    release = threading.Event()

    class LeaderStub:
        def close(self):
            pass

    def fake_lerobot(profile, leader=False):
        if not leader:
            return MockDriver()
        started.set()
        assert release.wait(2), "leader connect was never released"
        return LeaderStub()

    monkeypatch.setattr("robo_harness.service.LeRobotDriver", fake_lerobot)
    p = json.loads((ROOT / "config/robot.example.json").read_text())
    p["urdf"] = str(ROOT / "assets/so101.urdf")
    p["backend"] = "so101"  # non-mock, so the follower is built via LeRobotDriver
    with TestClient(create_app(p, TOKEN)) as client:
        headers = {"Authorization": "Bearer " + TOKEN}
        result = {}

        def acquire_leader():
            result["response"] = client.post(
                "/control/acquire",
                json={"owner": "lead", "mode": "leader"},
                headers=headers,
            )

        worker = threading.Thread(target=acquire_leader)
        worker.start()
        assert started.wait(2), "leader connect never started"
        # The leader is still connecting; /observe must return promptly because
        # the connect no longer holds engine.lock.
        began = time.monotonic()
        observed = client.get("/observe", headers=headers)
        assert observed.status_code == 200
        assert time.monotonic() - began < 1.0
        release.set()
        worker.join(timeout=3)
        assert result["response"].status_code == 200
