import json
from pathlib import Path

import pytest
from robo_harness.drivers import MockDriver
from robo_harness.engine import ControlError, Engine
from robo_harness.kinematics import Kinematics

ROOT = Path(__file__).resolve().parents[2]


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


@pytest.fixture
def rig():
    profile = json.loads((ROOT / "config/robot.example.json").read_text())
    clock = Clock()
    engine = Engine(MockDriver(), profile, Kinematics(str(ROOT / "assets/so101.urdf")), clock)
    return engine, clock


def advance(engine, clock, seconds):
    for _ in range(round(seconds * 30)):
        clock.advance(1 / 30)
        engine.tick()


def test_gripper_does_not_complete_on_accept(rig):
    e, c = rig
    lease = e.acquire("agent")
    op = e.submit("one", lease["lease_id"], "agent", target={"gripper": 45}, duration_s=1)
    assert op["status"] == "accepted"
    assert e.measured["gripper"] == 40
    advance(e, c, 1.2)
    assert e.get_operation(op["id"])["status"] == "completed"
    assert e.measured["gripper"] == pytest.approx(45)


def test_duplicate_and_conflicting_request(rig):
    e, c = rig
    lease = e.acquire("a")
    one = e.submit("r", lease["lease_id"], "a", target={"shoulder_pan": 2})
    two = e.submit("r", lease["lease_id"], "a", target={"shoulder_pan": 2})
    assert one["id"] == two["id"]
    with pytest.raises(ControlError, match="different motion"):
        e.submit("r", lease["lease_id"], "a", target={"shoulder_pan": 3})


def test_takeover_revokes_old_controller(rig):
    e, c = rig
    lease = e.acquire("a")
    op = e.submit("r", lease["lease_id"], "a", target={"shoulder_pan": 2})
    e.acquire("human", "human", True)
    assert e.get_operation(op["id"])["status"] == "cancelled"
    with pytest.raises(ControlError):
        e.renew(lease["lease_id"], "a")


def test_lease_loss_holds_last_commanded_pose(rig):
    e, c = rig
    lease = e.acquire("a")
    op = e.submit("r", lease["lease_id"], "a", target={"shoulder_pan": 9}, duration_s=5)
    advance(e, c, 3.3)
    q = e.commanded.copy()
    advance(e, c, 1)
    assert e.lease is None
    assert e.get_operation(op["id"])["status"] == "cancelled"
    assert e.commanded == q


def test_no_overlapping_motion(rig):
    e, c = rig
    lease = e.acquire("a")
    e.submit("r", lease["lease_id"], "a", target={"shoulder_pan": 2})
    with pytest.raises(ControlError, match="already running"):
        e.submit("r2", lease["lease_id"], "a", target={"shoulder_pan": 3})


@pytest.mark.parametrize(
    "target",
    [
        {"shoulder_pan": float("nan")},
        {"gripper": 101},
        {"unknown": 1},
        {"shoulder_pan": 11},
    ],
)
def test_invalid_targets_never_reach_driver(rig, target):
    e, c = rig
    lease = e.acquire("a")
    before = e.driver.read()
    with pytest.raises(ControlError):
        e.submit("r", lease["lease_id"], "a", target=target)
    assert e.driver.read() == before


def test_speed_rejection(rig):
    e, c = rig
    lease = e.acquire("a")
    with pytest.raises(ControlError, match="speed"):
        e.submit("r", lease["lease_id"], "a", target={"shoulder_pan": 5}, duration_s=0.1)


def test_stale_observation_rejects_command(rig):
    e, c = rig
    lease = e.acquire("a")
    c.advance(0.3)
    with pytest.raises(ControlError, match="stale"):
        e.submit("r", lease["lease_id"], "a", target={"shoulder_pan": 1})


def test_fault_latches_and_rejects_new_owner(rig):
    e, c = rig

    def broken():
        raise OSError("bus disconnected")

    e.driver.read = broken
    e.tick()
    assert "bus disconnected" in e.fault
    with pytest.raises(ControlError, match="latched"):
        e.acquire("a")


def test_cartesian_roundtrip_and_unreachable(rig):
    e, c = rig
    lease = e.acquire("a")
    xyz = e.kin.xyz(e.measured).tolist()
    op = e.submit("r", lease["lease_id"], "a", xyz=xyz)
    advance(e, c, 1.2)
    assert e.get_operation(op["id"])["status"] == "completed"
    with pytest.raises(ControlError, match="unreachable"):
        e.submit("r2", lease["lease_id"], "a", xyz=[2, 2, 2])


def test_link_keepout_is_checked(rig):
    e, c = rig
    lease = e.acquire("a")
    e.profile["keepout_boxes"] = [{"min": [-0.1, -0.1, -0.1], "max": [0.1, 0.1, 0.1]}]
    with pytest.raises(ControlError, match="keep-out"):
        e.submit("r", lease["lease_id"], "a", target={"shoulder_pan": 1})


def test_controller_cannot_renew_someone_elses_lease(rig):
    e, c = rig
    lease = e.acquire("a")
    with pytest.raises(ControlError):
        e.renew(lease["lease_id"], "b")


def test_deadline_miss_cancels_motion(rig):
    e, c = rig
    lease = e.acquire("a")
    op = e.submit("r", lease["lease_id"], "a", target={"shoulder_pan": 2})
    c.advance(0.5)
    e.tick()
    assert e.get_operation(op["id"])["status"] == "cancelled"


def test_stop_can_interrupt_planning_without_waiting_for_ik(rig):
    import threading

    e, clock = rig
    lease = e.acquire("a")
    planning = threading.Event()
    resume = threading.Event()
    original = e.kin.validate
    errors = []

    def slow_validate(pose, profile):
        planning.set()
        resume.wait(2)
        return original(pose, profile)

    e.kin.validate = slow_validate

    def submit():
        try:
            e.submit("slow", lease["lease_id"], "a", target={"shoulder_pan": 1})
        except ControlError as error:
            errors.append(str(error))

    worker = threading.Thread(target=submit)
    worker.start()
    assert planning.wait(1)
    assert e.lock.acquire(timeout=0.1), "Planning held the motor control lock"
    e.lock.release()
    e.stop("Operator cancelled during planning")
    resume.set()
    worker.join(timeout=3)
    assert not worker.is_alive()
    assert errors
    assert e.operation is None
    assert e.driver.read()["shoulder_pan"] == 0


def test_stale_camera_cancels_agent_motion(rig):
    e, clock = rig
    lease = e.acquire("a")
    operation = e.submit("camera", lease["lease_id"], "a", target={"shoulder_pan": 2})
    e.observation_guard = lambda: False
    advance(e, clock, 0.1)
    assert e.get_operation(operation["id"])["status"] == "cancelled"
    assert e.lease is None


def test_agent_cannot_acquire_without_camera_observation(rig):
    e, _ = rig
    e.observation_guard = lambda: False
    with pytest.raises(ControlError, match="Camera observation"):
        e.acquire("a")
    assert e.lease is None
    assert e.acquire("operator", mode="human")["mode"] == "human"
