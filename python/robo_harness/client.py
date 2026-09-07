"""Small synchronous client for agent-written robot programs."""

import os
import time
import uuid
from typing import Any

import httpx


class Robot:
    def __init__(self, url: str | None = None, token: str | None = None) -> None:
        credential = token or os.environ.get("ROBO_TOKEN")
        self.http = httpx.Client(
            base_url=url or os.environ.get("ROBO_URL", "http://127.0.0.1:8940"),
            headers={
                **({"Authorization": "Bearer " + credential} if credential else {}),
                "X-Robo-Controller": os.environ.get("ROBO_CONTROLLER", "python"),
            },
            timeout=130,
        )

    def call(self, name: str, **arguments: Any) -> dict[str, Any]:
        response = self.http.post("/api/tool/" + name, json=arguments)
        if response.is_error:
            raise RuntimeError(response.json().get("error", "Robot request failed"))
        return response.json()

    def observe(self) -> dict[str, Any]:
        return self.call("observe")

    def capture(self, camera: str = "workspace") -> dict[str, Any]:
        return self.call("capture", camera=camera)

    def __enter__(self) -> "Robot":
        self.call("acquire", mode="agent", takeover=False)
        return self

    def move(
        self,
        target: dict[str, float] | None = None,
        xyz: list[float] | None = None,
        duration_s: float = 1,
        timeout_s: float = 13,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {"request_id": str(uuid.uuid4()), "duration_s": duration_s}
        args["target" if target is not None else "xyz"] = target if target is not None else xyz
        operation = self.call("move", **args)
        deadline = time.monotonic() + timeout_s
        while operation["status"] in ("accepted", "running"):
            if time.monotonic() > deadline:
                self.call("stop")
                raise TimeoutError("Motion status timed out")
            self.call("renew")
            time.sleep(0.1)
            operation = self.call("operation", id=operation["id"])
        if operation["status"] != "completed":
            raise RuntimeError(operation.get("reason", operation["status"]))
        return operation

    def __exit__(self, *_: object) -> None:
        try:
            self.call("release")
        finally:
            self.http.close()
