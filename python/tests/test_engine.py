import json
import threading
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
    e, _ = rig
    lease = e.acquire("a")
    one = e.submit("r", lease["lease_id"], "a", target={"shoulder_pan": 2})
    two = e.submit("r", lease["lease_id"], "a", target={"shoulder_pan": 2})
    assert one["id"] == two["id"]
    with pytest.raises(ControlError, match="different motion"):
        e.submit("r", lease["lease_id"], "a", target={"shoulder_pan": 3})


def test_takeover_revokes_old_controller(rig):
    e, _ = rig
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
    e, _ = rig
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
    e, _ = rig
    lease = e.acquire("a")
    before = e.driver.read()
    with pytest.raises(ControlError):
        e.submit("r", lease["lease_id"], "a", target=target)
    assert e.driver.read() == before


def test_speed_rejection(rig):
    e, _ = rig
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
    e, _ = rig

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
    e, _ = rig
    lease = e.acquire("a")
    e.profile["keepout_boxes"] = [{"min": [-0.1, -0.1, -0.1], "max": [0.1, 0.1, 0.1]}]
    with pytest.raises(ControlError, match="keep-out"):
        e.submit("r", lease["lease_id"], "a", target={"shoulder_pan": 1})


def test_controller_cannot_renew_someone_elses_lease(rig):
    e, _ = rig
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


@pytest.mark.parametrize(
    ("delay", "remaining", "reason"),
    [(0.3, 3, "deadline missed"), (3.1, 3, "lease expired"), (0.1, 0.05, "lease expired")],
)
def test_blocking_motor_read_never_advances_motion_after_deadline(rig, delay, remaining, reason):
    e, clock = rig
    lease = e.acquire("operator", "human")
    op = e.submit("slow-read", lease["lease_id"], "operator", target={"shoulder_pan": 2})
    e.lease["expires"] = clock() + remaining
    held = e.commanded.copy()
    read = e.driver.read

    def slow_read():
        clock.advance(delay)
        return read()

    e.driver.read = slow_read
    clock.advance(1 / 30)
    e.tick()

    assert e.lease is None
    assert e.get_operation(op["id"])["status"] == "cancelled"
    assert reason in e.get_operation(op["id"])["reason"]
    assert e.commanded == held
    assert read() == held
    assert e.fault is None


@pytest.mark.parametrize("stage", ["leader_read", "validation"])
@pytest.mark.parametrize(("delay", "remaining"), [(0.3, 3), (0.1, 0.05)])
def test_blocking_leader_work_preserves_last_command(rig, stage, delay, remaining):
    e, clock = rig
    e.acquire("operator", "leader")
    e.lease["expires"] = clock() + remaining
    held = e.commanded.copy()
    closed = []

    class Leader:
        def read(self):
            if stage == "leader_read":
                clock.advance(delay)
            return {**held, "shoulder_pan": held["shoulder_pan"] + 1}

        def close(self):
            closed.append(True)

    validate = e.kin.validate

    def slow_validate(pose, profile):
        if stage == "validation":
            clock.advance(delay)
        validate(pose, profile)

    e.leader = Leader()
    e.kin.validate = slow_validate
    clock.advance(1 / 30)
    e.tick()

    assert e.lease is None
    assert e.leader is None
    assert closed == [True]
    assert e.commanded == held
    assert e.driver.read() == held
    assert e.fault is None


def test_stop_can_interrupt_planning_without_waiting_for_ik(rig):
    e, _ = rig
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


def test_replay_without_lease_is_rejected(rig):
    e, c = rig
    lease = e.acquire("agent")
    e.submit("r", lease["lease_id"], "agent", target={"gripper": 42}, duration_s=1)
    # The lease (3 s) expires and is revoked as the clock advances.
    advance(e, c, 4)
    with pytest.raises(ControlError):
        e.submit("r", lease["lease_id"], "agent", target={"gripper": 42}, duration_s=1)


def test_ledger_evicts_finished_operations_and_keeps_active(rig):
    e, _ = rig
    lease = e.acquire("agent")
    for i in range(10000):
        e.operations[("agent", f"old{i}")] = {
            "id": f"o{i}",
            "status": "completed",
            "_signature": (None, None, 1),
            "request_id": f"old{i}",
            "owner": "agent",
            "target": {},
            "residual": None,
        }
    assert len(e.operations) == 10000
    op = e.submit("fresh", lease["lease_id"], "agent", target={"gripper": 46}, duration_s=1)
    assert op["status"] == "accepted"
    assert len(e.operations) <= 10000
    # The freshly accepted (active) operation is retained, not evicted.
    assert ("agent", "fresh") in e.operations


def test_stale_acquisition_cannot_cross_stop_or_takeover(rig):
    e, _ = rig
    observation = e.observe()
    guard = {
        "expected_boot_id": observation["boot_id"],
        "expected_control_epoch": observation["control_epoch"],
    }
    e.stop()
    with pytest.raises(ControlError, match="stale acquisition"):
        e.acquire("late", **guard)
    assert e.lease is None
    guard["expected_control_epoch"] = e.control_epoch
    human = e.acquire("human", "human", True)
    e.release(human["lease_id"], "human")
    with pytest.raises(ControlError, match="stale acquisition"):
        e.acquire("late", **guard)
    with pytest.raises(ControlError, match="restarted"):
        e.acquire("late", expected_boot_id="old-boot")
    assert e.lease is None


def test_request_lookup_reconciles_without_a_live_lease(rig):
    e, c = rig
    lease = e.acquire("a")
    op = e.submit("lost-reply", lease["lease_id"], "a", target={"gripper": 42})
    advance(e, c, 1.5)
    e.release(lease["lease_id"], "a")
    result = e.find_operation("a", "lost-reply", e.boot_id)
    assert result["id"] == op["id"]
    assert result["status"] == "completed"
    assert result["measured"]["gripper"] == pytest.approx(42)
    assert e.find_operation("other", "lost-reply", e.boot_id) is None
    with pytest.raises(ControlError, match="unknown"):
        e.find_operation("a", "lost-reply", "old-boot")


def test_cancel_pending_owner_preserves_human_control(rig):
    e, _ = rig
    guard = {"expected_boot_id": e.boot_id, "expected_control_epoch": e.control_epoch}
    e.cancel_owner("pending", e.boot_id)
    with pytest.raises(ControlError, match="stale acquisition"):
        e.acquire("pending", **guard)
    human = e.acquire("human", "human", True)
    e.cancel_owner("pending", e.boot_id)
    assert e.lease["id"] == human["lease_id"]
    assert e.renew(human["lease_id"], "human")["owner"] == "human"


def test_terminal_operation_keeps_its_measured_snapshot(rig):
    e, c = rig
    lease = e.acquire("agent")
    op = e.submit("snapshot", lease["lease_id"], "agent", target={"gripper": 45}, duration_s=1)
    advance(e, c, 1.2)
    completed = e.get_operation(op["id"])
    assert completed["status"] == "completed"
    e.submit("later", lease["lease_id"], "agent", target={"gripper": 50}, duration_s=1)
    advance(e, c, 1.2)
    assert e.measured["gripper"] == pytest.approx(50)
    assert e.get_operation(op["id"])["measured"] == completed["measured"]
    assert e.find_operation("agent", "snapshot", e.boot_id)["residual"] == completed["residual"]


def test_real_profile_cartesian_gate_keeps_bounded_joint_probes_available(rig):
    # Real-profile rules on the mock driver: this test never opens hardware.
    engine, clock = rig
    engine.profile.update(backend="so101", cartesian_reviewed=False, max_step=2, max_speed=2)
    assert engine.observe()["cartesian"] is False
    lease = engine.acquire("visual-agent")
    with pytest.raises(ControlError, match="Cartesian calibration"):
        engine.submit("xyz", lease["lease_id"], "visual-agent", xyz=engine.kin.xyz(engine.measured).tolist())
    assert engine.operation is None
    operation = engine.submit(
        "probe", lease["lease_id"], "visual-agent", target={"shoulder_pan": 1}, duration_s=1
    )
    advance(engine, clock, 1.2)
    assert engine.get_operation(operation["id"])["status"] == "completed"
    assert engine.measured["shoulder_pan"] == pytest.approx(1)
    assert engine.observe()["cartesian"] is False


def test_unresponsive_joint_fails_and_owner_cleanup_preserves_result(rig):
    e, c = rig
    e.driver.write = lambda values: None
    lease = e.acquire("probe")
    op = e.submit("small-probe", lease["lease_id"], "probe", target={"shoulder_pan": 1}, duration_s=1.5)
    for _ in range(4):
        e.renew(lease["lease_id"], "probe")
        advance(e, c, 1)
    failed = e.get_operation(op["id"])
    assert failed["status"] == "failed"
    assert failed["reason"] == "Target did not settle before deadline"
    assert failed["measured"]["shoulder_pan"] == 0
    assert failed["residual"]["shoulder_pan"] == 1
    assert e.observe()["operator"] is None
    assert e.fault is None
    assert e.commanded["shoulder_pan"] == 1
    with pytest.raises(ControlError, match="lease is absent"):
        e.release(lease["lease_id"], "probe")
    assert e.cancel_owner("probe", e.boot_id) == {"cancelled": True}
    assert e.get_operation(op["id"]) == failed
    assert e.commanded["shoulder_pan"] == 1


def test_stream_follows_the_newest_setpoint_at_the_speed_limit(rig):
    e, c = rig
    lease = e.acquire("agent", mode="stream")
    start = e.commanded["shoulder_pan"]
    reply = e.set_stream_target(lease["lease_id"], "agent", {"shoulder_pan": start + 30})
    assert reply["accepted"]
    # One tick moves at most max_speed * dt, however far away the setpoint is.
    c.advance(1 / 30)
    e.tick()
    assert abs(e.commanded["shoulder_pan"] - start) <= e.profile["max_speed"] / 30 + 1e-9
    # A setpoint keeps the lease alive without a separate renew.
    for _ in range(8):
        c.advance(1 / 30)
        e.set_stream_target(lease["lease_id"], "agent", {"shoulder_pan": start + 30})
        e.tick()
    travelled = e.commanded["shoulder_pan"] - start
    assert 0 < travelled <= e.profile["max_speed"] * (9 / 30) + 1e-9
    assert e.observe()["stream"]["following"] is True
    assert e.fault is None


def test_stream_holds_when_setpoints_stop_arriving(rig):
    e, c = rig
    lease = e.acquire("agent", mode="stream")
    start = e.commanded["shoulder_pan"]
    e.set_stream_target(lease["lease_id"], "agent", {"shoulder_pan": start + 30})
    c.advance(1 / 30)
    e.tick()
    assert e.commanded["shoulder_pan"] != start
    # The arm keeps following for the stale window, then holds where it got to,
    # with the lease still live.
    advance(e, c, 0.4)
    held = e.commanded["shoulder_pan"]
    assert e.observe()["stream"]["following"] is False
    advance(e, c, 0.5)
    assert e.commanded["shoulder_pan"] == held
    assert e.lease is not None
    assert e.fault is None


def test_stream_refuses_a_target_outside_the_limits(rig):
    e, _ = rig
    lease = e.acquire("agent", mode="stream")
    lo, hi = e.profile["limits"]["shoulder_pan"]
    with pytest.raises(ControlError, match="commissioned limits"):
        e.set_stream_target(lease["lease_id"], "agent", {"shoulder_pan": hi + 1})
    with pytest.raises(ControlError, match="Unknown or empty joint target"):
        e.set_stream_target(lease["lease_id"], "agent", {"nope": 0})
    assert lo <= e.commanded["shoulder_pan"] <= hi
    assert e.fault is None


def test_stream_drops_a_setpoint_that_violates_geometry_without_latching(rig):
    e, c = rig
    lease = e.acquire("agent", mode="stream")

    def refuse(_pose, _profile):
        raise ValueError("would strike the table")

    e.kin.validate = refuse
    start = e.commanded.copy()
    e.set_stream_target(lease["lease_id"], "agent", {"shoulder_lift": start["shoulder_lift"] + 20})
    c.advance(1 / 30)
    e.tick()
    assert e.commanded == start
    assert e.fault is None
    stream = e.observe()["stream"]
    assert stream["rejected"] == "would strike the table"
    assert e.lease is not None


def test_stream_mode_owns_motion_and_ends_with_the_lease(rig):
    e, _ = rig
    lease = e.acquire("agent", mode="stream")
    with pytest.raises(ControlError, match="Stream control owns motion"):
        e.submit("r", lease["lease_id"], "agent", target={"shoulder_pan": 1})
    e.stop()
    assert e.setpoint is None
    with pytest.raises(ControlError, match="lease is absent"):
        e.set_stream_target(lease["lease_id"], "agent", {"shoulder_pan": 1})


def test_stream_command_leads_the_measured_position_by_at_most_one_step(rig):
    e, c = rig
    lease = e.acquire("agent", mode="stream")
    start = e.measured["shoulder_pan"]
    # A joint that will not move: the command must lead it enough to break the
    # servo's dead band, and no further.
    e.driver.read = lambda: {**e.measured, "shoulder_pan": start}
    for _ in range(90):
        c.advance(1 / 30)
        e.set_stream_target(lease["lease_id"], "agent", {"shoulder_pan": start + 40})
        e.tick()
    lead = e.commanded["shoulder_pan"] - start
    assert lead == pytest.approx(e.profile["max_step"])
    assert e.fault is None


class FakeLeader:
    def __init__(self, target):
        self.target = target
        self.closed = False

    def read(self):
        return dict(self.target)

    def close(self):
        self.closed = True


def test_leader_mode_follows_the_leader_at_the_speed_limit_and_owns_motion(rig):
    e, c = rig
    lease = e.acquire("teleop", mode="leader")
    start = e.commanded.copy()
    e.leader = FakeLeader({**start, "shoulder_pan": start["shoulder_pan"] + 30})
    c.advance(1 / 30)
    e.tick()
    moved = e.commanded["shoulder_pan"] - start["shoulder_pan"]
    assert 0 < moved <= e.profile["max_speed"] / 30 + 1e-9
    with pytest.raises(ControlError, match="Leader teleoperation owns motion"):
        e.submit("r", lease["lease_id"], "teleop", target={"shoulder_pan": 1})
    e.release(lease["lease_id"], "teleop")
    assert e.leader is None
    assert e.fault is None


def test_leader_target_outside_the_commissioned_range_latches_a_fault(rig):
    e, c = rig
    e.acquire("teleop", mode="leader")
    _, hi = e.profile["limits"]["shoulder_pan"]
    e.leader = FakeLeader({**e.commanded, "shoulder_pan": hi + 5})
    before = e.commanded.copy()
    c.advance(1 / 30)
    e.tick()
    assert e.fault is not None
    assert "commissioned range" in e.fault
    assert e.commanded == before


def test_joints_the_target_does_not_mention_hold_their_command_not_their_sag(rig):
    e, c = rig
    lease = e.acquire("agent")
    # The lift sags below its command under gravity, as a real joint does.
    e.measured = {**e.measured, "shoulder_lift": e.commanded["shoulder_lift"] - 0.4}
    op = e.submit("pan", lease["lease_id"], "agent", target={"shoulder_pan": e.measured["shoulder_pan"] + 1})
    assert op["target"]["shoulder_lift"] == e.commanded["shoulder_lift"]
    assert op["start"]["shoulder_lift"] == e.commanded["shoulder_lift"]
    # And the commanded joint is stepped from where it actually is.
    assert op["start"]["shoulder_pan"] == e.measured["shoulder_pan"]
    advance(e, c, 0.1)
    assert e.commanded["shoulder_lift"] == op["target"]["shoulder_lift"]


def test_a_move_is_judged_on_the_joints_it_asked_to_move(rig):
    e, c = rig
    lease = e.acquire("agent")
    # A joint nobody is moving sags below its command, as a loaded joint does.
    op = e.submit("pan", lease["lease_id"], "agent", target={"shoulder_pan": e.measured["shoulder_pan"] + 1})
    plain = e.driver.read
    e.driver.read = lambda: {**plain(), "shoulder_lift": plain()["shoulder_lift"] - 1.4}
    advance(e, c, 1.4)
    done = e.get_operation(op["id"])
    assert done["status"] == "completed"
    # The sag is still reported, it just does not decide the verdict.
    assert done["residual"]["shoulder_lift"] > 0.8


def test_a_held_gripper_stalled_off_its_command_does_not_fail_the_speed_check(rig):
    e, _ = rig
    lease = e.acquire("agent")
    # Jaws closed on an object stop several percent short of their command.
    e.measured = {**e.measured, "gripper": e.commanded["gripper"] + 6}
    op = e.submit("pan", lease["lease_id"], "agent", target={"shoulder_pan": e.measured["shoulder_pan"] + 1})
    assert op["target"]["gripper"] == e.commanded["gripper"]


def test_servo_temperatures_are_sampled_rarely_and_never_fault_control(rig):
    e, c = rig
    advance(e, c, 1.1)
    assert e.observe()["temperatures"] == dict.fromkeys(e.measured, 25)

    def broken():
        raise RuntimeError("bus busy")

    e.driver.temperatures = broken
    advance(e, c, 1.1)
    assert e.fault is None
    assert e.observe()["temperatures"] is None
