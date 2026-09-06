"""Small synchronous client for agent-written robot programs."""

import os
import time
import uuid

import httpx


class Robot:
    def __init__(self, url=None, token=None):
        credential = token or os.environ.get("ROBO_TOKEN")
        self.http = httpx.Client(
            base_url=url or os.environ.get("ROBO_URL", "http://127.0.0.1:8940"),
            headers={
                **({"Authorization": "Bearer " + credential} if credential else {}),
                "X-Robo-Controller": os.environ.get("ROBO_CONTROLLER", "python"),
            },
            timeout=130,
        )

    def call(self, name, **arguments):
        response = self.http.post("/api/tool/" + name, json=arguments)
        if response.is_error:
            raise RuntimeError(response.json().get("error", "Robot request failed"))
        return response.json()

    def observe(self):
        return self.call("observe")

    def capture(self, camera="workspace"):
        return self.call("capture", camera=camera)

    def __enter__(self):
        self.call("acquire", mode="agent", takeover=False)
        return self

    def move(self, target=None, xyz=None, duration_s=1, timeout_s=13):
        args = {"request_id": str(uuid.uuid4()), "duration_s": duration_s}
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

    def __exit__(self, *_):
        try:
            self.call("release")
        finally:
            self.http.close()
