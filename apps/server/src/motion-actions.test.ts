import { expect, test } from "bun:test";

import type { Lease, Observation, Operation } from "@robo/domain";

import {
  createMotionExecutor,
  type ActionLedger,
  type ActionRecord,
  type MotionIO,
} from "./motion-actions";

const pose = {
  shoulder_pan: 0,
  shoulder_lift: 0,
  elbow_flex: 0,
  wrist_flex: 0,
  wrist_roll: 0,
  gripper: 40,
};
const observation = (): Observation => ({
  boot_id: "boot",
  control_epoch: 0,
  seq: 1,
  monotonic_s: 1,
  wall_time_ms: 1,
  clock_domain: "boot",
  age_ms: 0,
  units: {},
  backend: "mock",
  calibration_id: "fixture",
  measured: pose,
  commanded: pose,
  ee: [0, 0, 0],
  frames: {},
  cameras: {},
  operator: null,
  operation: null,
  fault: null,
  limits: {
    shoulder_pan: [-90, 90],
    shoulder_lift: [-90, 90],
    elbow_flex: [-90, 90],
    wrist_flex: [-90, 90],
    wrist_roll: [-90, 90],
    gripper: [0, 100],
  },
  max_step: 2,
  cartesian: false,
  trajectory: [],
});
const rig = () => {
  const records = new Map<string, ActionRecord>();
  const ledger: ActionLedger = {
    get: (id) => records.get(id) ?? null,
    save: (record) => {
      records.set(record.id, structuredClone(record));
    },
  };
  const state = {
    now: 0,
    epoch: 0,
    owner: "",
    expires: 0,
    acquires: 0,
    submits: 0,
    renews: 0,
    cancels: 0,
    releases: 0,
    op: null as Operation | null,
    lostReply: false,
    hold: false,
  };
  const check = (lease: Lease) => {
    if (lease.owner !== state.owner || state.now >= state.expires)
      throw new Error("Lease lost");
  };
  const io: MotionIO = {
    observe: async () => ({ ...observation(), control_epoch: state.epoch }),
    acquire: async (owner, observed, signal) => {
      signal.throwIfAborted();
      if (observed.control_epoch !== state.epoch)
        throw new Error("Revoked acquisition");
      state.acquires += 1;
      state.owner = owner;
      state.expires = state.now + 3;
      return { owner, lease_id: "lease", ttl_ms: 3000, mode: "agent" };
    },
    renew: async (lease, signal) => {
      signal.throwIfAborted();
      check(lease);
      state.renews += 1;
      state.expires = state.now + 3;
      return lease;
    },
    submit: async (lease, input, signal) => {
      signal.throwIfAborted();
      check(lease);
      state.submits += 1;
      state.op = {
        id: "op",
        owner: lease.owner,
        request_id: input.request_id,
        status: "running",
        target: { ...pose, ...input.target },
        residual: null,
      };
      if (state.lostReply) throw new Error("Response lost after acceptance");
      return state.op;
    },
    operation: async () => {
      if (!state.op) throw new Error("No operation");
      if (!state.hold && state.op.status === "running")
        state.op = {
          ...state.op,
          status: "completed",
          measured: state.op.target,
          residual: { ...pose, gripper: 0 },
        };
      return state.op;
    },
    find: async () => state.op,
    release: async (lease) => {
      state.releases += 1;
      if (state.owner === lease.owner) state.owner = "";
    },
    cancel: async (owner) => {
      state.cancels += 1;
      state.epoch += 1;
      if (state.owner === owner) {
        state.owner = "";
        if (state.op) state.op = { ...state.op, status: "cancelled" };
      }
    },
    rejected: () => false,
  };
  return {
    state,
    io,
    ledger,
    records,
    executor: createMotionExecutor(io, ledger, {
      pollMs: 5,
      renewMs: 10,
      marginMs: 150,
    }),
  };
};
const request = (id = "one", signal = new AbortController().signal) => ({
  id,
  owner: `owner-${id}`,
  input: { target: { gripper: 42 }, duration_s: 0.1 },
  signal,
  progress: () => {},
});

test("thinking before the tool does not consume a lease, even after 30 seconds", async () => {
  for (const seconds of [1, 5, 15, 30]) {
    const r = rig();
    r.state.now += seconds;
    const result = await r.executor.execute(request());
    expect(result.status).toBe("completed");
    expect(result.operation?.measured?.gripper).toBe(42);
    expect(r.state.acquires).toBe(1);
    expect(r.state.releases).toBe(1);
    expect(r.state.owner).toBe("");
  }
});

test("a lost accepted reply is reconciled under the original request without resubmission", async () => {
  const r = rig();
  r.state.lostReply = true;
  const result = await r.executor.execute(request());
  expect(result.status).toBe("completed");
  expect(r.state.submits).toBe(1);
  expect(result.request_id).toBe(r.state.op?.request_id ?? "");
  const duplicate = await r.executor.execute(request());
  expect(duplicate.request_id).toBe(result.request_id);
  expect(r.state.acquires).toBe(1);
  const restarted = createMotionExecutor(r.io, r.ledger);
  await restarted.execute(request());
  expect(r.state.submits).toBe(1);
});

test("concurrent motion is rejected instead of queued", async () => {
  const r = rig();
  const gate = Promise.withResolvers<Observation>();
  r.io.observe = () => gate.promise;
  const first = r.executor.execute(request("first"));
  const rejected = await Promise.allSettled([
    r.executor.execute(request("second")),
  ]);
  expect(rejected[0]).toMatchObject({
    status: "rejected",
    reason: { code: "MOTION_BUSY" },
  });
  gate.resolve(observation());
  expect((await first).status).toBe("completed");
  expect(r.state.submits).toBe(1);
});

test("cancel before invocation never acquires", async () => {
  const r = rig();
  const abort = new AbortController();
  abort.abort();
  const rejected = await Promise.allSettled([
    r.executor.execute(request("cancel", abort.signal)),
  ]);
  expect(rejected[0]?.status).toBe("rejected");
  expect(r.state.acquires).toBe(0);
});

test("cancel during acquisition invalidates a late request and never submits", async () => {
  const r = rig();
  const entered = Promise.withResolvers<boolean>();
  const gate = Promise.withResolvers<boolean>();
  const acquire = r.io.acquire;
  r.io.acquire = async (...args) => {
    entered.resolve(true);
    await gate.promise;
    return acquire(...args);
  };
  const abort = new AbortController();
  const action = r.executor.execute(request("cancel", abort.signal));
  await entered.promise;
  abort.abort();
  const result = await action;
  expect(result.status).toBe("cancelled");
  expect(r.state.cancels).toBe(1);
  gate.resolve(true);
  await Bun.sleep(5);
  expect(r.state.acquires).toBe(0);
  expect(r.state.submits).toBe(0);
});

test("human takeover stops supervision and cleanup preserves the human lease", async () => {
  const r = rig();
  r.state.hold = true;
  const action = r.executor.execute(request());
  await Bun.sleep(15);
  r.state.owner = "human";
  if (r.state.op)
    r.state.op = {
      ...r.state.op,
      status: "cancelled",
      reason: "Human takeover",
    };
  const result = await action;
  expect(result.status).toBe("cancelled");
  expect(r.state.owner).toBe("human");
  expect(r.state.acquires).toBe(1);
});

test("deadline cancels a running action and stops heartbeat", async () => {
  const r = rig();
  r.state.hold = true;
  const result = await r.executor.execute(request());
  expect(result.status).toBe("cancelled");
  expect(r.state.cancels).toBe(1);
  const renewals = r.state.renews;
  await Bun.sleep(25);
  expect(r.state.renews).toBe(renewals);
});

test("unsafe targets fail before acquiring control", async () => {
  const r = rig();
  const result = await r.executor.execute({
    ...request(),
    input: { target: { gripper: 90 }, duration_s: 1 },
  });
  expect(result.status).toBe("failed");
  expect(result.message).toContain("UNSAFE_TARGET");
  expect(r.state.acquires).toBe(0);
});

test("cancel during submission cancels the accepted request without resubmission", async () => {
  const r = rig();
  const submitted = Promise.withResolvers<boolean>();
  const gate = Promise.withResolvers<Operation>();
  const submit = r.io.submit;
  r.io.submit = async (...args) => {
    await submit(...args);
    submitted.resolve(true);
    return gate.promise;
  };
  const abort = new AbortController();
  const action = r.executor.execute(request("in-flight", abort.signal));
  await submitted.promise;
  abort.abort();
  const result = await action;
  expect(result.status).toBe("cancelled");
  expect(result.code).toBe("CANCELLED");
  expect(r.state.submits).toBe(1);
  expect(r.state.owner).toBe("");
  if (r.state.op) gate.resolve(r.state.op);
});

test("renewal failure stops the action and never reacquires", async () => {
  const r = rig();
  r.state.hold = true;
  r.io.renew = async () => {
    throw new Error("Control lease expired");
  };
  const result = await r.executor.execute(request());
  expect(["cancelled", "failed"]).toContain(result.status);
  expect(r.state.acquires).toBe(1);
  expect(r.state.cancels).toBe(1);
  expect(r.state.owner).toBe("");
});

test("unreachable service leaves an unknown outcome that cannot be replayed after restart", async () => {
  const r = rig();
  r.state.lostReply = true;
  r.io.find = async () => {
    throw new Error("Network unavailable");
  };
  r.io.cancel = async () => {
    throw new Error("Network unavailable");
  };
  const result = await r.executor.execute(request());
  expect(result.status).toBe("unknown");
  expect(result.code).toBe("OUTCOME_UNKNOWN");
  expect(result.message).toContain("renewal has stopped");
  const renews = r.state.renews;
  await Bun.sleep(25);
  expect(r.state.renews).toBe(renews);
  expect(await createMotionExecutor(r.io, r.ledger).execute(request())).toEqual(
    result
  );
  expect(r.state.submits).toBe(1);
});

test("a journaled pending action is not replayed by a restarted executor", async () => {
  const r = rig();
  r.ledger.save({
    id: "one",
    owner: "owner-one",
    requestId: "original",
    input: request().input,
    bootId: "boot",
    result: null,
  });
  const result = await createMotionExecutor(r.io, r.ledger).execute(request());
  expect(result.status).toBe("unknown");
  expect(result.request_id).toBe("original");
  expect(r.state.acquires).toBe(0);
  expect(r.state.submits).toBe(0);
});

test("steering during acquisition releases control without submitting the old move", async () => {
  const r = rig();
  let revised = false;
  const acquire = r.io.acquire;
  r.io.acquire = async (...args) => {
    const lease = await acquire(...args);
    revised = true;
    return lease;
  };
  const result = await r.executor.execute({
    ...request(),
    assertCurrent: () => {
      if (revised) throw new Error("OPERATOR_STEERED: New instruction");
    },
  });
  expect(result.status).toBe("failed");
  expect(r.state.submits).toBe(0);
  expect(r.state.owner).toBe("");
  expect(r.state.cancels).toBe(1);
});

test("uncommissioned XYZ is refused without disabling bounded joint exploration", async () => {
  const r = rig();
  const xyz = await r.executor.execute({
    ...request("uncommissioned-xyz"),
    input: { xyz: [0.2, 0, 0.1], duration_s: 1 },
  });
  expect(xyz.status).toBe("failed");
  expect(xyz.code).toBe("CAPABILITY_UNAVAILABLE");
  expect(r.state.acquires).toBe(0);
  expect(r.state.submits).toBe(0);

  const probe = await r.executor.execute(request("visual-joint-probe"));
  expect(probe.status).toBe("completed");
  expect(r.state.submits).toBe(1);
  expect(r.state.owner).toBe("");
});
