import { expect, test } from "bun:test";

import { candidates, defaultLimits, validate } from "./candidates";
import { fixtureObservation, fixtures } from "./fixtures";
import { parseGoal, resolveTask } from "./tasks";

const motion = (ids: readonly string[]) =>
  ids.filter((id) => !["reobserve", "wait", "stop", "done"].includes(id));

test("motion is offered only for usable observations", () => {
  for (const item of fixtures) {
    const ids = candidates(
      item.obs,
      { goal: item.goal, explore: [] },
      defaultLimits
    ).map((action) => action.id);
    expect(ids).toContain("stop");
    const unusable = [
      "stale-observation",
      "wrist-camera-error",
      "no-camera-telemetry",
      "fault-latched",
      "motion-in-progress",
    ].includes(item.name);
    if (unusable) expect(motion(ids)).toEqual([]);
  }
});

test("steps are capped by the local step and the robot max_step", () => {
  const obs = fixtureObservation({ max_step: 1 });
  const offered = candidates(
    obs,
    { goal: { gripper: 40 }, explore: [] },
    defaultLimits
  );
  expect(motion(offered.map((action) => action.id))).toEqual([
    "gripper+0.8",
    "gripper-0.8",
  ]);
});

test("validation refuses drift, restarts, foreign control, limits and unoffered actions", () => {
  const basis = fixtureObservation();
  const offered = candidates(
    basis,
    { goal: { gripper: 34 }, explore: [] },
    defaultLimits
  );
  const step = offered.find((action) => action.id === "gripper+1.8");
  if (step?.kind !== "step") throw new Error("expected gripper+1.8");
  expect(validate(step, offered, basis, basis, defaultLimits)).toEqual({
    ok: true,
  });
  const drifted = fixtureObservation({
    measured: { ...basis.measured, gripper: 31 },
  });
  expect(validate(step, offered, basis, drifted, defaultLimits).ok).toBe(false);
  const restarted = fixtureObservation({ boot_id: "other" });
  expect(validate(step, offered, basis, restarted, defaultLimits).ok).toBe(
    false
  );
  const owned = fixtureObservation({
    operator: { owner: "browser-x", mode: "human", remaining_ms: 2000 },
  });
  expect(validate(step, offered, basis, owned, defaultLimits).ok).toBe(false);
  const stale = fixtureObservation({ age_ms: 900 });
  expect(validate(step, offered, basis, stale, defaultLimits).ok).toBe(false);
  expect(
    validate({ ...step, id: "gripper+9" }, offered, basis, basis, defaultLimits)
      .ok
  ).toBe(false);
  expect(
    validate({ ...step, target: 101 }, offered, basis, basis, defaultLimits).ok
  ).toBe(false);
});

test("goals are relative when signed, absolute otherwise, and inside limits", () => {
  const obs = fixtureObservation();
  expect(parseGoal("gripper=+4,wrist_flex=-2", obs)).toEqual({
    gripper: 34,
    wrist_flex: 39,
  });
  expect(parseGoal("gripper=12", obs)).toEqual({ gripper: 12 });
  expect(() => parseGoal("gripper=+80", obs)).toThrow();
  expect(() => parseGoal("elbow=1", obs)).toThrow();
  expect(resolveTask("control-smoke", obs).stages).toEqual([
    { gripper: 34 },
    { wrist_flex: 43 },
    { wrist_flex: 41 },
  ]);
});
