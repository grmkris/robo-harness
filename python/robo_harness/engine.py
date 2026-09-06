"""Single-writer control state machine; no camera, inference, storage, or network I/O here."""

import copy
import math
import threading
import time
import uuid
from collections import OrderedDict

from .kinematics import JOINTS


class ControlError(Exception):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


class Engine:
    def __init__(self, driver, profile, kinematics, clock=time.monotonic):
        self.driver, self.profile, self.kin, self.clock = driver, profile, kinematics, clock
        self.lock = threading.RLock()
        self.boot_id = str(uuid.uuid4())
        self.measured = driver.read()
        self.commanded = self.measured.copy()
        self.lease = None
        self.operation = None
        self.operations = OrderedDict()
        self.fault = None
        self.seq = 0
        self.last_observed = clock()
        self.last_wall_ms = time.time() * 1000
        self.last_tick = clock()
        self.leader = None
        self.observation_guard = lambda: True
        self.trajectory = []
        self.profile["limits"] = {j: profile["limits"][j] for j in JOINTS}

    def observe(self):
        with self.lock:
            now = self.clock()
            lease = self.lease
            frames = self.kin.frames(self.measured)
            return {
                "boot_id": self.boot_id,
                "seq": self.seq,
                "monotonic_s": self.last_observed,
                "wall_time_ms": self.last_wall_ms,
                "server_time_ms": time.time() * 1000,
                "clock_domain": self.boot_id,
                "age_ms": (now - self.last_observed) * 1000,
                "backend": self.profile["backend"],
                "calibration_id": self.profile["calibration_id"],
                "units": {**{j: "degrees" for j in JOINTS[:-1]}, "gripper": "percent"},
                "measured": self.measured.copy(),
                "commanded": self.commanded.copy(),
                "ee": self.kin.xyz(self.measured).tolist(),
                "frames": {k: v.tolist() for k, v in frames.items()},
                "operator": None
                if not lease
                else {
                    "owner": lease["owner"],
                    "mode": lease["mode"],
                    "remaining_ms": max(0, (lease["expires"] - now) * 1000),
                },
                "operation": copy.deepcopy(self.operation),
                "fault": self.fault,
                "limits": self.profile["limits"],
                "max_step": self.profile["max_step"],
                "trajectory": copy.deepcopy(self.trajectory),
                "cartesian": self.profile["backend"] == "mock"
                or self.profile.get("cartesian_reviewed", False),
            }

    def acquire(self, owner, mode="agent", takeover=False):
        if mode not in ("human", "agent", "leader"):
            raise ControlError("Unknown controller mode", 400)
        with self.lock:
            if self.fault:
                raise ControlError("Hardware fault is latched; inspect before restarting the service")
            if mode == "agent" and not self.observation_guard():
                raise ControlError("Camera observation is stale or unavailable", 503)
            if self.lease and self.lease["expires"] > self.clock():
                if self.lease["owner"] == owner and self.lease["mode"] == mode and not takeover:
                    return self._lease_reply()
                if not takeover:
                    raise ControlError("Robot already has a controller")
            self._stop("Controller changed")
            self.lease = {"id": str(uuid.uuid4()), "owner": owner, "mode": mode, "expires": self.clock() + 3}
            return self._lease_reply()

    def _lease_reply(self):
        return {
            "lease_id": self.lease["id"],
            "ttl_ms": 3000,
            "owner": self.lease["owner"],
            "mode": self.lease["mode"],
        }

    def _check_lease(self, lease_id, owner):
        if (
            not self.lease
            or self.lease["id"] != lease_id
            or self.lease["owner"] != owner
            or self.lease["expires"] <= self.clock()
        ):
            raise ControlError("Control lease is absent, expired, or belongs to another controller")
        if self.fault or self.clock() - self.last_observed > 0.25:
            raise ControlError("Robot observation is stale or faulted")

    def renew(self, lease_id, owner):
        with self.lock:
            self._check_lease(lease_id, owner)
            self.lease["expires"] = self.clock() + 3
            return self._lease_reply()

    def release(self, lease_id, owner):
        with self.lock:
            self._check_lease(lease_id, owner)
            self._stop("Controller released")
            self.lease = None

    def stop(self, reason="Stopped by operator"):
        with self.lock:
            self._stop(reason)
            self.lease = None
            return self.observe()

    def _stop(self, reason):
        if self.operation and self.operation["status"] in ("accepted", "running"):
            self.operation.update(status="cancelled", reason=reason, finished_ms=time.time() * 1000)
        # Hold the last commanded position, not the sagged measured position.
        self.trajectory = []
        if self.leader:
            try:
                self.leader.close()
            except Exception:
                pass
            self.leader = None

    def submit(self, request_id, lease_id, owner, target=None, xyz=None, duration_s=1.0):
        with self.lock:
            key = (owner, request_id)
            signature = (target, xyz, duration_s)
            if key in self.operations:
                old = self.operations[key]
                if old["_signature"] != signature:
                    raise ControlError("Request ID was reused with different motion")
                return self._public(old)
            self._check_lease(lease_id, owner)
            if self.lease["mode"] == "leader":
                raise ControlError("Leader teleoperation owns motion")
            if not request_id or len(request_id) > 128:
                raise ControlError("A bounded request ID is required", 400)
            if self.operation and self.operation["status"] in ("accepted", "running"):
                raise ControlError("A motion is already running")
            start = self.measured.copy()
        # Trajectory planning must never hold the motor-thread mutex.
        if not math.isfinite(duration_s) or not 0.1 <= duration_s <= 10:
            raise ControlError("Duration must be between 0.1 and 10 seconds", 400)
        if (target is None) == (xyz is None):
            raise ControlError("Specify joints or Cartesian target, exclusively", 400)
        if xyz is not None:
            if not (self.profile["backend"] == "mock" or self.profile.get("cartesian_reviewed")):
                raise ControlError("Cartesian calibration has not been reviewed")
            if len(xyz) != 3 or not all(math.isfinite(v) for v in xyz):
                raise ControlError("Cartesian target must contain three finite meters", 400)
            try:
                target = self.kin.inverse(start, xyz, self.profile["limits"])
            except ValueError as e:
                raise ControlError(str(e), 422) from e
        if not target or any(j not in JOINTS for j in target):
            raise ControlError("Unknown or empty joint target", 400)
        goal = {**start, **target}
        for j, v in goal.items():
            lo, hi = self.profile["limits"][j]
            if (
                isinstance(v, bool)
                or not isinstance(v, (int, float))
                or not math.isfinite(v)
                or not lo <= v <= hi
            ):
                raise ControlError(f"{j} target exceeds commissioned limits", 422)
            delta = abs(v - start[j])
            if delta > self.profile["max_step"] + 1e-8:
                raise ControlError(f"{j} move exceeds maximum per-operation step", 422)
            if delta / duration_s > self.profile["max_speed"] + 1e-8:
                raise ControlError(f"{j} move exceeds maximum speed", 422)
        samples = []
        try:
            for n in range(31):
                p = {j: start[j] + (goal[j] - start[j]) * n / 30 for j in JOINTS}
                self.kin.validate(p, self.profile)
                samples.append(self.kin.xyz(p).tolist())
        except ValueError as e:
            raise ControlError(str(e), 422) from e
        with self.lock:
            self._check_lease(lease_id, owner)
            if key in self.operations:
                old = self.operations[key]
                if old["_signature"] != signature:
                    raise ControlError("Request ID was reused with different motion")
                return self._public(old)
            if self.operation and self.operation["status"] in ("accepted", "running"):
                raise ControlError("A motion is already running")
            if any(abs(self.measured[j] - start[j]) > 0.5 for j in JOINTS):
                raise ControlError("Robot moved while planning; observe and replan")
            if len(self.operations) >= 10000:
                raise ControlError("Operation ledger is full; start a new reviewed service session")
            self.operation = {
                "id": str(uuid.uuid4()),
                "request_id": request_id,
                "owner": owner,
                "status": "accepted",
                "target": goal,
                "start": start,
                "duration_s": duration_s,
                "started_ms": time.time() * 1000,
                "_started": self.clock(),
                "_signature": signature,
                "residual": None,
            }
            self.operations[key] = self.operation
            self.trajectory = samples
            return self._public(self.operation)

    def get_operation(self, operation_id):
        with self.lock:
            for op in self.operations.values():
                if op["id"] == operation_id:
                    return self._public(op)
        raise ControlError("Operation not found in this service boot", 404)

    @staticmethod
    def _public(op):
        return copy.deepcopy({k: v for k, v in op.items() if not k.startswith("_")})

    def tick(self):
        with self.lock:
            now = self.clock()
            dt = min(max(now - self.last_tick, 0), 0.1)
            gap = now - self.last_tick
            self.last_tick = now
            try:
                self.measured = self.driver.read()
                if any(not math.isfinite(v) for v in self.measured.values()):
                    raise RuntimeError("Non-finite motor observation")
                self.last_observed = now
                self.last_wall_ms = time.time() * 1000
                self.seq += 1
                if gap > 0.25 and self.lease:
                    self._stop("Control loop deadline missed")
                    self.lease = None
                if self.lease and self.lease["expires"] <= now:
                    self._stop("Control lease expired")
                    self.lease = None
                if self.lease and self.lease["mode"] == "agent" and not self.observation_guard():
                    self._stop("Camera observation is stale or unavailable")
                    self.lease = None
                if self.fault:
                    return
                if self.leader and self.lease:
                    target = self.leader.read()
                    if set(target) != set(JOINTS):
                        raise RuntimeError("Leader joint set does not match follower")
                    proposed = {}
                    for j in JOINTS:
                        lo, hi = self.profile["limits"][j]
                        if not math.isfinite(target[j]) or not lo <= target[j] <= hi:
                            raise RuntimeError("Leader target outside commissioned range")
                        step = self.profile["max_speed"] * dt
                        proposed[j] = self.commanded[j] + max(-step, min(step, target[j] - self.commanded[j]))
                    self.kin.validate(proposed, self.profile)
                    self.commanded = proposed
                op = self.operation
                if op and op["status"] in ("accepted", "running"):
                    op["status"] = "running"
                    alpha = min(1.0, (now - op["_started"]) / op["duration_s"])
                    self.commanded = {
                        j: op["start"][j] + (op["target"][j] - op["start"][j]) * alpha for j in JOINTS
                    }
                    residual = {j: abs(self.measured[j] - op["target"][j]) for j in JOINTS}
                    op["residual"] = residual
                    if alpha >= 1 and all(v <= (2 if j == "gripper" else 0.8) for j, v in residual.items()):
                        op.update(status="completed", finished_ms=time.time() * 1000)
                    elif now - op["_started"] > op["duration_s"] + 2:
                        op.update(
                            status="failed",
                            reason="Target did not settle before deadline",
                            finished_ms=time.time() * 1000,
                        )
                        self.lease = None
                self.driver.write(self.commanded)
            except Exception as e:
                self.fault = f"{type(e).__name__}: {e}"
                if self.operation and self.operation["status"] in ("accepted", "running"):
                    self.operation.update(status="failed", reason=self.fault)
                self._stop("Hardware fault")
                self.lease = None
                # A failed bus cannot promise hold. Fault remains latched.
