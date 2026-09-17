import { expect, test } from "bun:test";

import type { Lease, Observation, Operation } from "@robo/domain";

import {
  createMotionExecutor,
  type ActionLedger,
  type ActionRecord,
  type MotionIO,
} from "../motion-actions";
import { defaultLimits } from "./candidates";
import { fixtureObservation } from "./fixtures";
import { runDecisionLoop } from "./loop";
import { pickupDefaults, pickupTracker, type PickupConfig } from "./pickup";
import type { Detection } from "./state";
import { rulesDecider } from "./strategies";
import { resolveTask } from "./tasks";

/**
 * A toy arm for the pickup phases: the model end effector drops as
 * shoulder_lift/elbow_flex increase, the piece moves in the wrist image with
 * pan (x) and elbow (y), and closing stalls at 12 % once the jaws are low.
 */
const start = {
  shoulder_pan: 0,
  shoulder_lift: -10,
  elbow_flex: 10,
  wrist_flex: 80,
  wrist_roll: 0,
  gripper: 20,
};
const hover = {
  shoulder_pan: -3,
  shoulder_lift: -6,
  elbow_flex: 10,
  wrist_flex: 80,
};
const config: PickupConfig = {
  ...pickupDefaults,
  hover,
  graspZ: 0.01,
  graspPoint: { x: -0.1, y: 0.1 },
};
const eeZ = (m: typeof start) =>
  0.08 -
  0.004 * (m.shoulder_lift - hover.shoulder_lift) -
  0.0025 * (m.elbow_flex - hover.elbow_flex);
const blob = (m: typeof start): Detection => ({
  source: "white-blob/v1",
  camera: "wrist",
  frame_age_ms: 30,
  visible: true,
  center_x: 0.25 + 0.05 * (m.shoulder_pan - hover.shoulder_pan),
  center_y: 0.25 - 0.04 * (m.elbow_flex - hover.elbow_flex),
});

const toyArm = () => {
  const records = new Map<string, ActionRecord>();
  const ledger: ActionLedger = {
    get: (id) => records.get(id) ?? null,
    save: (record) => {
      records.set(record.id, structuredClone(record));
    },
  };
  let measured = { ...start };
  let op: Operation | null = null;
  let seq = 1;
  let submits = 0;
  const observe = (): Observation => {
    seq += 1;
    return fixtureObservation({
      backend: "mock",
      measured,
      commanded: measured,
      seq,
      ee: [0.22, 0, eeZ(measured)],
    });
  };
  const io: MotionIO = {
    observe: async () => observe(),
    acquire: async (owner) =>
      ({ owner, lease_id: "l", ttl_ms: 3000, mode: "agent" }) satisfies Lease,
    renew: async (lease) => lease,
    submit: async (lease, input) => {
      submits += 1;
      op = {
        id: `op${submits}`,
        owner: lease.owner,
        request_id: input.request_id,
        status: "running",
        target: { ...measured, ...input.target },
        residual: null,
      };
      return op;
    },
    operation: async () => {
      if (!op) throw new Error("no op");
      if (op.status === "running") {
        const low = eeZ(op.target) <= config.graspZ + 0.01;
        if (low && op.target.gripper < 12 && measured.gripper >= 12) {
          measured = { ...op.target, gripper: 12 };
          op = {
            ...op,
            status: "failed",
            reason: "Target did not settle before deadline",
            measured,
            residual: { ...measured, gripper: 12 - op.target.gripper },
          };
        } else {
          measured = op.target;
          op = {
            ...op,
            status: "completed",
            measured,
            residual: { ...measured, gripper: 0 },
          };
        }
      }
      return op;
    },
    find: async () => op,
    release: async () => {},
    cancel: async () => {},
    rejected: () => false,
  };
  const executor = createMotionExecutor(io, ledger, {
    pollMs: 1,
    renewMs: 5,
    marginMs: 200,
  });
  return { io, executor, measured: () => measured, submits: () => submits };
};

test("the tracker walks open → approach → center → descend → grasp → lift on a toy arm with the rules baseline", async () => {
  const arm = toyArm();
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const obs = fixtureObservation({ backend: "mock", measured: start });
  const summary = await runDecisionLoop(
    {
      observe: arm.io.observe,
      execute: arm.executor.execute,
      decider: rulesDecider(),
      log: (event, data) => events.push({ event, data }),
      sleep: () => Promise.resolve(),
      perceive: async (o) => [blob(o.measured)],
    },
    {
      runId: "pickup",
      mode: "execute",
      task: resolveTask("pickup-white-piece", obs),
      tracker: pickupTracker(config),
      limits: defaultLimits,
      maxSteps: 250,
      maxSeconds: 60,
      signal: new AbortController().signal,
    }
  );
  const phases = events
    .filter((e) => e.event === "stage_reached")
    .map((e) => e.data["phase"]);
  expect(phases).toEqual([
    "open",
    "approach",
    "center",
    "descend",
    "grasp",
    "lift",
  ]);
  expect(summary.end_reason).toBe("done");
  expect(summary.task_complete).toBe(true);
  expect(arm.measured().gripper).toBe(12);
  expect(
    events.some((e) => {
      const note = e.data["task_note"];
      return typeof note === "string" && note.includes("contact");
    })
  ).toBe(true);
});

test("ordinary gripper lag while open is not contact, and empty closes reopen then fail", () => {
  const tracker = pickupTracker({ ...config, maxEmptyCloses: 2 });
  const at = (m: Partial<typeof start>, z = 0) =>
    fixtureObservation({
      measured: { ...start, ...m },
      commanded: { ...start, ...m },
      ee: [0.22, 0, z],
    });
  const seen = [blob({ ...start, ...hover })];
  // Walk to the grasp phase.
  tracker.advance(at({ gripper: 55, ...hover }, 0.08), seen);
  const centered = [
    {
      ...seen[0],
      center_x: config.graspPoint.x,
      center_y: config.graspPoint.y,
    } as Detection,
  ];
  expect(
    tracker.advance(at({ gripper: 55, ...hover }, 0.005), centered).phase
  ).toBe("grasp");
  const lag = tracker.onStep?.({
    action: {
      id: "gripper-1.8",
      kind: "step",
      joint: "gripper",
      delta: -1.8,
      target: 53.2,
      duration_s: 1,
      description: "",
    },
    status: "completed",
    before: at({ gripper: 55 }),
    after: at({ gripper: 54.9 }),
  });
  expect(lag?.expected).toBe(false);
  const firstEmpty = tracker.advance(
    at({ gripper: 1, ...hover }, 0.005),
    centered
  );
  expect(firstEmpty.phase).toBe("open");
  tracker.advance(at({ gripper: 55, ...hover }, 0.08), centered);
  tracker.advance(at({ gripper: 55, ...hover }, 0.005), centered);
  const secondEmpty = tracker.advance(
    at({ gripper: 1, ...hover }, 0.005),
    centered
  );
  expect(secondEmpty.failed).toContain("closed empty 2 times");
});
