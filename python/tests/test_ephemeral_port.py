"""The I/O service resolves --port 0 to a real port and announces it."""

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_service_announces_ephemeral_port():
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "robo_harness.service",
            "--profile",
            "config/robot.example.json",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
        ],
        cwd=ROOT,
        env={
            "PYTHONPATH": str(ROOT / "python"),
            "PATH": "/usr/bin:/bin",
            "ROBO_IO_TOKEN": "ephemeral-port-test-token-2026",
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    assert proc.stdout is not None
    try:
        deadline = time.time() + 15
        announced = None
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("event") == "listening":
                announced = event
                break
        assert announced is not None, "service never announced a listening port"
        assert announced["port"] > 0
        assert announced["host"] == "127.0.0.1"
    finally:
        proc.terminate()
        proc.wait(timeout=10)
