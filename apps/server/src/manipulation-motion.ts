import type { Joint, Observation } from "@robo/domain";

import {
  position,
  tipFrame,
  toolPoint,
  type Vec3,
} from "./decision/kinematics";
import { jointHealth } from "./decision/scene-state";
import {
  goToward,
  moveTip,
  newMemory,
  skillDefaults,
  stepToward,
  type MoveOutcome,
  type SkillContext,
} from "./decision/skills";
import { insidePolygon, type ManipulationConfig } from "./manipulation-config";
import { ToolFailure } from "./tool-errors";

type Target = Partial<Record<Joint, number>>;

interface MotionDependencies {
  observe: () => Promise<Observation>;
  move: (target: Target, durationS: number) => Promise<MoveOutcome>;
  signal: AbortSignal;
}

class Interrupted extends Error {
  readonly outcome: MoveOutcome;
  readonly observation: Observation;
  constructor(outcome: MoveOutcome, observation: Observation) {
    super(outcome.message);
    this.outcome = outcome;
    this.observation = observation;
  }
}

const transient =
  /camera.*stale|camera.*unavailable|control loop deadline missed/iu;
const unsettled = /did not settle/iu;

export const tcpPosition = (
  obs: Observation,
  config: ManipulationConfig
): Vec3 => toolPoint(tipFrame(obs.measured), config.tcp_offset_m);

/** Motion tools share the motor executor through deps.move. No lease is held between steps. */
export const manipulationMotion = (
  config: ManipulationConfig,
  deps: MotionDependencies
) => {
  const memory = newMemory();
  let latest: Observation;
  let context: SkillContext;

  const fresh = async () => {
    deps.signal.throwIfAborted();
    const obs = await deps.observe();
    if (obs.fault || obs.age_ms > 250) {
      throw new ToolFailure({
        code: "UNSAFE_TARGET",
        detail: "Observation is stale or faulted; no motion submitted.",
      });
    }
    if (
      obs.backend === "so101" &&
      (!obs.temperatures || Object.keys(obs.temperatures).length < 6)
    ) {
      throw new ToolFailure({
        code: "CAPABILITY_UNAVAILABLE",
        detail: "Servo temperatures are unavailable; no motion submitted.",
      });
    }
    if (Object.values(obs.temperatures ?? {}).some((value) => value > 60)) {
      throw new ToolFailure({
        code: "UNSAFE_TARGET",
        detail:
          "Servo temperature is above 60 C. Pause for ten minutes and reobserve.",
      });
    }
    if (
      ["workspace", "wrist"].some((role) => {
        const camera = obs.cameras[role];
        return (
          !camera ||
          camera.error !== null ||
          camera.age_ms === null ||
          camera.age_ms > 400
        );
      })
    ) {
      throw new ToolFailure({
        code: "TRANSIENT_CAMERA",
        detail:
          "Camera feedback is stale. Wait and look again; no motion submitted.",
      });
    }
    latest = obs;
    return obs;
  };

  const fence = (xyz: Vec3) => {
    const polygon = config.safe_zone.polygon;
    if (
      Math.hypot(xyz[0], xyz[1]) > config.safe_zone.max_radius_m + 1e-6 ||
      (polygon && !insidePolygon(polygon, xyz[0], xyz[1])) ||
      xyz[2] < config.table_z_m - 0.0001
    ) {
      throw new ToolFailure({
        code: "UNSAFE_TARGET",
        detail:
          "TCP target is outside the commissioned polygon, radius or table plane.",
      });
    }
  };

  const init = async () => {
    if (
      !config.commissioned ||
      !config.safe_zone.polygon ||
      !config.home_pose
    ) {
      throw new ToolFailure({
        code: "CAPABILITY_UNAVAILABLE",
        detail:
          "TCP, safe polygon and home pose must be commissioned before using manipulation motion.",
      });
    }
    const initial = await fresh();
    context = {
      observe: fresh,
      look: async () => ({
        visible: false,
        x: null,
        y: null,
        size: 0,
        background: false,
      }),
      config: {
        ...skillDefaults,
        limits: initial.limits,
        moveCapDeg: Math.min(1.6, initial.max_step * 0.8),
        maxReachM: config.safe_zone.max_radius_m,
        // moveTip has a 4 mm floor margin; the TCP floor itself is the table plane.
        matZ: config.table_z_m - 0.0041,
      },
      memory,
      signal: deps.signal,
      maxMoves: 160,
      deadlineMs: performance.now() + 180_000,
      move: async (target) => {
        const before = await fresh();
        const next = { ...before.measured, ...target };
        fence(tcpPosition({ ...before, measured: next }, config));
        if (
          position(tipFrame(next))[2] <
          config.table_z_m + config.table_clearance_m
        ) {
          throw new ToolFailure({
            code: "UNSAFE_TARGET",
            detail: "Gripper frame would cross the reviewed table clearance.",
          });
        }
        const delta = Math.max(
          0,
          ...Object.entries(target).map(([joint, value]) =>
            Math.abs(value - before.measured[joint as Joint])
          )
        );
        const result = await deps.move(
          target,
          Math.max(0.5, delta / config.speed_units_s)
        );
        const after = result.after ?? (await deps.observe());
        latest = after;
        // Do not let the legacy helper retry a failed/contact step or reacquire after takeover.
        if (result.status !== "completed") throw new Interrupted(result, after);
        return { ...result, after };
      },
    };
    return initial;
  };

  const measured = (obs: Observation) => ({
    measured: obs.measured,
    tcp_xyz_m: tcpPosition(obs, config),
    temperatures: obs.temperatures ?? null,
    fault: obs.fault,
    moves: memory.movesUsed,
    joint_health: jointHealth(memory.jointHistory),
  });

  const interrupted = (error: unknown) => {
    if (!(error instanceof Interrupted)) throw error;
    if (transient.test(error.message)) {
      throw new ToolFailure({
        code: "TRANSIENT_CAMERA",
        detail:
          "Protective camera/loop stop. Wait and look again; this tool stopped without retrying.",
      });
    }
    return {
      status: error.outcome.status,
      reached: false,
      message: error.message,
      ...measured(error.observation),
      contact:
        error.outcome.status === "failed" && unsettled.test(error.message),
    };
  };

  const geometry = {
    offset: config.tcp_offset_m,
    toleranceM: 0.002,
    segmentM: 0.006,
    // Match measured motor completion instead of repeating sub-deadband goals.
    // The final Cartesian residual remains the success criterion.
    toleranceDeg: 0.8,
  };

  const moveTo = async (target: Vec3) => {
    const before = await fresh();
    const from = tcpPosition(before, config);
    // Fence the whole straight path before the first motor write, including concave polygons.
    const segments = Math.max(
      1,
      Math.ceil(Math.hypot(...target.map((v, i) => v - from[i]!)) / 0.002)
    );
    for (let i = 0; i <= segments; i += 1) {
      fence([
        from[0] + ((target[0] - from[0]) * i) / segments,
        from[1] + ((target[1] - from[1]) * i) / segments,
        from[2] + ((target[2] - from[2]) * i) / segments,
      ]);
    }
    const out = await moveTip(
      context,
      [target[0] - from[0], target[1] - from[1], target[2] - from[2]],
      160 - memory.movesUsed,
      geometry
    );
    return {
      status: out.reached ? "completed" : "failed",
      reached: out.reached,
      message: out.vetoed ?? "Measured TCP residual " + out.errorM + " m",
      residual_m: out.errorM,
      ...measured(out.obs),
    };
  };

  return {
    moveTcp: async (target: Vec3, relative = false) => {
      const obs = await init();
      const from = tcpPosition(obs, config);
      try {
        return await moveTo(
          relative
            ? [from[0] + target[0], from[1] + target[1], from[2] + target[2]]
            : target
        );
      } catch (error) {
        return interrupted(error);
      }
    },
    descend: async (maxDz: number) => {
      const obs = await init();
      const from = tcpPosition(obs, config);
      const bottom = Math.max(config.table_z_m + 0.0002, from[2] - maxDz);
      try {
        for (let z = from[2] - 0.003; z >= bottom - 0.003; z -= 0.003) {
          const out = await moveTo([from[0], from[1], Math.max(bottom, z)]);
          if (!out.reached)
            return {
              ...out,
              contact: false,
              stopped: "motion_did_not_reach",
              contact_height_m: out.tcp_xyz_m[2],
            };
          if (z <= bottom) break;
        }
        return {
          status: "completed",
          reached: true,
          contact: false,
          stopped: "descent_bound",
          contact_height_m: tcpPosition(latest, config)[2],
          ...measured(latest),
        };
      } catch (error) {
        const out = interrupted(error);
        return {
          ...out,
          stopped: "first_failed_step",
          contact_height_m: out.tcp_xyz_m[2],
        };
      }
    },
    roll: async (deg: number) => {
      const obs = await init();
      const [lo, hi] = obs.limits.wrist_roll;
      if (deg < lo || deg > hi)
        throw new ToolFailure({
          code: "UNSAFE_TARGET",
          detail: "Wrist roll exceeds commissioned limits.",
        });
      try {
        const out = await goToward(context, { wrist_roll: deg }, 160, 0.8);
        return {
          reached: out.reached,
          residual_deg: deg - out.obs.measured.wrist_roll,
          ...measured(out.obs),
        };
      } catch (error) {
        return interrupted(error);
      }
    },
    grip: async (percent: number) => {
      let obs = await init();
      try {
        for (let i = 0; i < 100; i += 1) {
          const out = await stepToward(context, obs, { gripper: percent }, 0.7);
          obs = out.obs;
          if (out.reached)
            return {
              reached: true,
              stalled_at: null,
              requested_percent: percent,
              ...measured(obs),
            };
          if (!out.progressed)
            return {
              reached: false,
              stalled_at: obs.measured.gripper,
              requested_percent: percent,
              ...measured(obs),
            };
        }
        return {
          reached: false,
          stalled_at: null,
          message: "Move bound reached",
          ...measured(obs),
        };
      } catch (error) {
        const out = interrupted(error);
        return {
          ...out,
          stalled_at: out.contact ? out.measured.gripper : null,
          requested_percent: percent,
        };
      }
    },
    home: async () => {
      const obs = await init();
      const home = config.home_pose;
      if (!home)
        throw new ToolFailure({
          code: "CAPABILITY_UNAVAILABLE",
          detail: "No home pose.",
        });
      const target = tcpPosition(
        { ...obs, measured: { ...obs.measured, ...home } },
        config
      );
      if (target[2] - config.table_z_m < 0.05)
        throw new ToolFailure({
          code: "UNSAFE_TARGET",
          detail: "Home must be at least 5 cm above the table.",
        });
      try {
        const current = tcpPosition(obs, config);
        // Raise before translating; returning home never releases a held object.
        const raised = await moveTo([
          current[0],
          current[1],
          Math.max(current[2], target[2]),
        ]);
        if (!raised.reached) return raised;
        const moved = await moveTo([
          target[0],
          target[1],
          Math.max(current[2], target[2]),
        ]);
        if (!moved.reached) return moved;
        const arrived = await moveTo(target);
        if (!arrived.reached) return arrived;
        const { gripper: _gripper, ...armHome } = home;
        const restored = await goToward(
          context,
          armHome,
          160 - memory.movesUsed,
          0.8
        );
        return { reached: restored.reached, ...measured(restored.obs) };
      } catch (error) {
        return interrupted(error);
      }
    },
  };
};
