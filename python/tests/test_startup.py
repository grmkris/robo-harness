from types import SimpleNamespace

import pytest
from robo_harness.drivers import configure_follower_with_hold


class Bus:
    def __init__(self, position=2000):
        self.motors = {"shoulder_pan": object(), "gripper": object()}
        self.calibration = {name: SimpleNamespace(range_min=1000, range_max=3000) for name in self.motors}
        self.positions = dict.fromkeys(self.motors, position)
        self.events = []

    def disable_torque(self):
        self.events.append("off")

    def configure_motors(self):
        self.events.append("configure")

    def write(self, name, motor, value):
        self.events.append(("write", name, motor, value))

    def sync_read(self, name, normalize):
        assert name == "Present_Position" and normalize is False
        self.events.append("read_current")
        return self.positions.copy()

    def sync_write(self, name, values, normalize):
        assert name == "Goal_Position" and normalize is False
        self.events.append(("goal", values))

    def enable_torque(self):
        self.events.append("on")


def test_current_goal_is_written_after_configuration_before_torque():
    bus = Bus()
    configure_follower_with_hold(bus)
    assert bus.events[0] == "off"
    assert bus.events[-3:] == ["read_current", ("goal", bus.positions), "on"]


def test_out_of_calibration_rest_pose_does_not_enable_torque():
    bus = Bus(position=3008)
    with pytest.raises(ValueError, match="reposition with torque off"):
        configure_follower_with_hold(bus)
    assert "on" not in bus.events
    assert not any(isinstance(e, tuple) and e[0] == "goal" for e in bus.events)


def test_configuration_failure_does_not_enable_torque():
    bus = Bus()

    def fail():
        raise RuntimeError("Bus unavailable")

    bus.configure_motors = fail
    with pytest.raises(RuntimeError):
        configure_follower_with_hold(bus)
    assert bus.events == ["off"]


def test_explicit_small_recovery_seeds_only_in_range_goals_before_torque():
    bus = Bus()
    bus.positions["shoulder_pan"] = 3008
    configure_follower_with_hold(bus, {"shoulder_pan": 2992})
    assert bus.events[-2:] == [("goal", {"shoulder_pan": 2992, "gripper": 2000}), "on"]


@pytest.mark.parametrize("target", [2900, 3001, float("nan")])
def test_recovery_rejects_large_or_out_of_range_targets(target):
    bus = Bus()
    bus.positions["shoulder_pan"] = 3008
    with pytest.raises(ValueError):
        configure_follower_with_hold(bus, {"shoulder_pan": target})
    assert "on" not in bus.events
    assert not any(isinstance(e, tuple) and e[0] == "goal" for e in bus.events)
