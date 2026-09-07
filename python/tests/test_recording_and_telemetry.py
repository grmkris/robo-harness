import json
import subprocess
import sys
from pathlib import Path

import pytest
import rerun as rr
from robo_harness.dataset import resample
from robo_harness.drivers import MockDriver
from robo_harness.engine import Engine
from robo_harness.kinematics import Kinematics
from robo_harness.perception import create_app
from robo_harness.telemetry import initialize, log_observation

ROOT = Path(__file__).resolve().parents[2]


def test_resampling_preserves_real_time_and_rejects_gaps():
    samples = [{"sample_time_ms": t, "index": i} for i, t in enumerate([1000, 1106, 1201, 1305])]
    assert [s["index"] for s in resample(samples, 10)] == [0, 1, 2, 3]
    with pytest.raises(ValueError, match="gap"):
        resample([{"sample_time_ms": 1000}, {"sample_time_ms": 1500}], 10)


def test_rerun_writes_readable_recording(tmp_path):
    profile = json.loads((ROOT / "config/robot.example.json").read_text())
    engine = Engine(MockDriver(), profile, Kinematics(str(ROOT / "assets/so101.urdf")))
    stream = rr.RecordingStream("robo-test")
    path = tmp_path / "test.rrd"
    stream.save(path)
    initialize(stream)
    log_observation(stream, engine.observe())
    stream.flush()
    stream.disconnect()
    assert path.stat().st_size > 1000
    # Open through Rerun's actual dataframe loader, not just file-existence checks.
    checked = subprocess.run(
        [str(Path(sys.executable).with_name("rerun")), "rrd", "verify", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert checked.returncode == 0, checked.stderr


def test_worker_rejects_missing_auth(monkeypatch):
    monkeypatch.delenv("ROBO_PERCEPTION_TOKEN", raising=False)
    with pytest.raises(ValueError, match="TOKEN"):
        create_app()
