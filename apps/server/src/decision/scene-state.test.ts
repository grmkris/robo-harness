import { expect, test } from "bun:test";

import { jointHealth, type SceneState } from "./scene-state";
import type { JointMove } from "./skills";
import { rulesNext } from "./tactics";

const move = (
  joint: JointMove["joint"],
  commandedDeg: number,
  achievedDeg: number
): JointMove => ({ joint, commandedDeg, achievedDeg });

test("a joint that achieves most of what it is asked follows; one that does not names its direction", () => {
  const health = jointHealth([
    move("shoulder_pan", 1.6, 1.4),
    move("shoulder_pan", -1.6, -1.5),
    move("shoulder_pan", 1.6, 1.3),
    // shoulder_lift is asked to go negative (raising) and barely moves.
    move("shoulder_lift", -1.6, -0.2),
    move("shoulder_lift", -1.6, 0),
    move("shoulder_lift", -1.6, -0.3),
    move("shoulder_lift", 1.6, 1.5),
  ]);
  expect(health["shoulder_pan"]?.follows).toBe(true);
  expect(health["shoulder_pan"]?.stalled_direction).toBeNull();
  expect(health["shoulder_lift"]?.follows).toBe(false);
  expect(health["shoulder_lift"]?.stalled_direction).toBe("-");
  expect(health["shoulder_lift"]?.lag_deg).toBeGreaterThan(1);
});

test("fewer than three moves is not enough to call a joint stalled", () => {
  const health = jointHealth([
    move("elbow_flex", 1.6, 0.1),
    move("elbow_flex", 1.6, 0),
  ]);
  expect(health["elbow_flex"]?.follows).toBe(true);
});

const scene = (
  jointHealth: SceneState["observed"]["joint_health"],
  lastResult: string | null
): SceneState =>
  ({
    mission: "",
    robot: {} as SceneState["robot"],
    observed: {
      piece: {
        visible_wrist: false,
        offset_x: null,
        offset_y: null,
        centered: false,
        size_frac: null,
        unseen_for_steps: 2,
      },
      gripper: {
        opening_pct: 50,
        open_enough: true,
        stalled_on_object: false,
        holding: false,
      },
      tip: {
        height_above_mat_cm: 4,
        at_grasp_height: false,
        high_enough_to_sweep: true,
        lifted_with_piece: false,
        pointing_down: 0.97,
      },
      last_skill: {
        name: "scan_for_piece",
        result: lastResult,
        detail: null,
        repeats: 0,
      },
      progress: { skills_run: 1, moves_used: 40, moves_left: 360 },
      joint_health: jointHealth,
    },
  }) as SceneState;

test("the rules stop instead of retrying a skill that stalled on a joint that no longer follows", () => {
  const stalled = {
    shoulder_lift: {
      follows: false,
      lag_deg: 1.4,
      stalled_direction: "-" as const,
      moves: 6,
    },
  };
  expect(rulesNext(scene(stalled, "stalled"))).toBe("stop");
  // The same joint state after a skill that finished is not a reason to stop.
  expect(rulesNext(scene(stalled, "done"))).toBe("scan_for_piece");
  const healthy = {
    shoulder_lift: {
      follows: true,
      lag_deg: 0.3,
      stalled_direction: null,
      moves: 6,
    },
  };
  expect(rulesNext(scene(healthy, "stalled"))).toBe("scan_for_piece");
});
