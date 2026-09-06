"""Authenticated robot HTTP service. No motor or camera device access on import."""

import argparse
import hmac
import json
import os
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .cameras import Cameras
from .drivers import LeRobotDriver, MockDriver
from .engine import ControlError, Engine
from .kinematics import Kinematics


class Acquire(BaseModel):
    model_config = ConfigDict(extra="forbid")
    owner: str = Field(min_length=1, max_length=128)
    mode: str = "agent"
    takeover: bool = False


class Lease(BaseModel):
    model_config = ConfigDict(extra="forbid")
    owner: str
    lease_id: str


class Move(Lease):
    request_id: str = Field(min_length=1, max_length=128)
    target: dict[str, float] | None = None
    xyz: list[float] | None = None
    duration_s: float = 1.0


def create_app(profile: dict, token: str, run_loop=True):
    if len(token) < 24:
        raise ValueError("ROBO_IO_TOKEN must have at least 24 characters")
    engine = None
    cameras = None
    stop = threading.Event()
    thread = None

    @asynccontextmanager
    async def lifespan(app):
        nonlocal engine, cameras, thread
        # Validate geometry and acquire cameras before enabling motor torque.
        kin = Kinematics(profile["urdf"], profile.get("joint_offsets_deg"))
        cameras = Cameras(profile, str(uuid.uuid4()))
        driver = None
        try:
            driver = MockDriver() if profile["backend"] == "mock" else LeRobotDriver(profile)
            engine = Engine(driver, profile, kin)
            engine.boot_id = cameras.domain
        except BaseException:
            cameras.close()
            if driver is not None:
                driver.close()
            raise
        engine.observation_guard = lambda: all(
            s["age_ms"] is not None and s["age_ms"] < 500 and not s["error"]
            for s in cameras.status().values()
        )

        def loop():
            next_tick = time.monotonic()
            while not stop.is_set():
                engine.tick()
                next_tick += 1 / 30
                stop.wait(max(0, next_tick - time.monotonic()))
                if next_tick < time.monotonic() - 0.1:
                    next_tick = time.monotonic()

        if run_loop:
            thread = threading.Thread(target=loop, daemon=True, name="motor-owner")
            thread.start()
        try:
            yield
        finally:
            engine.stop("Service shutting down")
            stop.set()
            if thread:
                thread.join(timeout=2)
            cameras.close()
            driver.close()

    app = FastAPI(
        title="Robo Harness I/O", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None
    )

    @app.middleware("http")
    async def auth(request: Request, call_next):
        if not hmac.compare_digest(request.headers.get("authorization", ""), "Bearer " + token):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        if request.headers.get("content-length") and int(request.headers["content-length"]) > 65536:
            return JSONResponse({"error": "Request too large"}, status_code=413)
        return await call_next(request)

    @app.exception_handler(ControlError)
    async def control_error(request, e):
        return JSONResponse({"error": str(e)}, status_code=e.status)

    @app.get("/observe")
    def observe():
        result = engine.observe()
        result["cameras"] = cameras.status()
        if result["operation"]:
            result["operation"] = {k: v for k, v in result["operation"].items() if not k.startswith("_")}
        return result

    @app.get("/frames/{name}")
    def frame(name: str, frame_id: str | None = None):
        try:
            return cameras.get(name, frame_id)
        except ValueError as e:
            raise ControlError(str(e), 503) from e

    @app.post("/control/acquire")
    def acquire(body: Acquire):
        lease = engine.acquire(body.owner, body.mode, body.takeover)
        if body.mode == "leader":
            try:
                with engine.lock:
                    if profile["backend"] == "mock":
                        raise ControlError("Leader hardware is not present in mock mode", 422)
                    engine.leader = LeRobotDriver(profile, leader=True)
            except Exception:
                engine.stop("Leader connection failed")
                raise
        return lease

    @app.post("/control/renew")
    def renew(body: Lease):
        return engine.renew(body.lease_id, body.owner)

    @app.post("/control/release")
    def release(body: Lease):
        engine.release(body.lease_id, body.owner)
        return {"released": True}

    @app.post("/control/stop")
    def halt():
        return engine.stop()

    @app.post("/operations")
    def move(body: Move):
        return engine.submit(**body.model_dump())

    @app.get("/operations/{operation_id}")
    def operation(operation_id: str):
        return engine.get_operation(operation_id)

    return app


def main():
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="config/robot.example.json")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8941)
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "::1") and not args.host.startswith("100."):
        parser.error("Bind to loopback or an explicit Tailscale address")
    profile = json.loads(Path(args.profile).read_text())
    if profile["backend"] not in ("mock", "so101"):
        parser.error("Unknown backend")
    uvicorn.run(
        create_app(profile, os.environ.get("ROBO_IO_TOKEN", "")),
        host=args.host,
        port=args.port,
        access_log=False,
    )


if __name__ == "__main__":
    main()
