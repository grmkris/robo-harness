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
import { runDecisionLoop, type LoopDeps, type LoopOptions } from "./loop";
import { rulesDecider } from "./strategies";
import { resolveTask, stageTracker } from "./tasks";

/** A fake motor owner: moves complete instantly unless told to lose replies or hold. */
const rig = (mode: "normal" | "lost" | "fail" | "partial" = "normal") => {
  const records = new Map<string, ActionRecord>();
  const ledger: ActionLedger = {
    get: (id) => records.get(id) ?? null,
    save: (record) => {
      records.set(record.id, structuredClone(record));
    },
  };
  let measured = fixtureObservation({ backend: "mock" }).measured;
  let seq = 1;
  let op: Operation | null = null;
  const calls = { observe: 0, acquire: 0, submit: 0, cancel: 0 };
  const observe = (): Observation => {
    seq += 1;
    return fixtureObservation({
      backend: "mock",
      measured,
      commanded: measured,
      seq,
    });
  };
  const io: MotionIO = {
    observe: async () => {
      calls.observe += 1;
      return observe();
    },
    acquire: async (owner) => {
      calls.acquire += 1;
      return {
        owner,
        lease_id: "lease",
        ttl_ms: 3000,
        mode: "agent",
      } satisfies Lease;
    },
    renew: async (lease) => lease,
    submit: async (lease, input) => {
      calls.submit += 1;
      const target = { ...measured, ...input.target };
      op = {
        id: `op${calls.submit}`,
        owner: lease.owner,
        request_id: input.request_id,
        status: "running",
        target,
        residual: null,
      };
      if (mode === "lost") throw new Error("reply lost");
      return op;
    },
    operation: async () => {
      if (!op) throw new Error("no op");
      if (op.status === "running") {
        if (mode === "partial") {
          const shortfall = {
            ...op.target,
            gripper:
              measured.gripper + (op.target.gripper - measured.gripper) * 0.6,
          };
          measured = shortfall;
          op = {
            ...op,
            status: "failed",
            reason: "Target did not settle before deadline",
            residual: { ...measured, gripper: 0.72 },
          };
        } else if (mode === "fail") {
          op = {
            ...op,
            status: "failed",
            reason: "Target did not settle before deadline",
            residual: { ...measured, gripper: 1.5 },
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
    find: async () => (mode === "lost" ? null : op),
    release: async () => {},
    cancel: async () => {
      calls.cancel += 1;
    },
    rejected: () => false,
  };
  const executor = createMotionExecutor(io, ledger, {
    pollMs: 2,
    renewMs: 5,
    marginMs: 200,
  });
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const deps = (): LoopDeps => ({
    observe: io.observe,
    execute: executor.execute,
    decider: rulesDecider(),
    log: (event, data) => events.push({ event, data }),
    sleep: () => Promise.resolve(),
  });
  return { calls, events, deps, measured: () => measured };
};

const task = () =>
  resolveTask("control-smoke", fixtureObservation({ backend: "mock" }));
const options = (
  over: Partial<Omit<LoopOptions, "tracker" | "task">> = {}
): LoopOptions => {
  const resolved = task();
  return {
    runId: "run",
    mode: "execute",
    task: resolved,
    tracker: stageTracker(resolved, defaultLimits),
    limits: defaultLimits,
    maxSteps: 20,
    maxSeconds: 30,
    signal: new AbortController().signal,
    ...over,
  };
};

test("dry-run never reaches the executor", async () => {
  const r = rig();
  let executed = 0;
  const summary = await runDecisionLoop(
    {
      ...r.deps(),
      execute: () => {
        executed += 1;
        throw new Error("must not run");
      },
    },
    options({ mode: "dry-run", maxSteps: 5 })
  );
  expect(executed).toBe(0);
  expect(r.calls.submit + r.calls.acquire).toBe(0);
  expect(summary.executed).toBe(0);
  expect(
    r.events.filter((e) => e.data["outcome"] === "not executed (dry-run)")
      .length
  ).toBe(5);
});

test("execute walks every stage with measured completion, then finishes done", async () => {
  const r = rig();
  const summary = await runDecisionLoop(r.deps(), options());
  expect(summary.end_reason).toBe("done");
  expect(summary.task_complete).toBe(true);
  expect(summary.stages_reached).toBe(3);
  expect(summary.completed).toBe(r.calls.submit);
  expect(Math.abs(r.measured().gripper - 34)).toBeLessThanOrEqual(1);
  expect(Math.abs(r.measured().wrist_flex - 41)).toBeLessThanOrEqual(0.8);
});

test("an unknown outcome ends the run without resubmitting", async () => {
  const r = rig("lost");
  const summary = await runDecisionLoop(r.deps(), options());
  expect(summary.end_reason).toBe("unknown_outcome");
  expect(r.calls.submit).toBe(1);
});

test("two failed steps stop the run", async () => {
  const r = rig("fail");
  const summary = await runDecisionLoop(r.deps(), options());
  expect(summary.end_reason).toBe("repeated_failures");
  expect(summary.failed).toBe(2);
});

test("cancellation ends the run before another decision", async () => {
  const r = rig();
  const abort = new AbortController();
  abort.abort(new Error("operator stop"));
  const summary = await runDecisionLoop(
    r.deps(),
    options({ signal: abort.signal })
  );
  expect(summary.end_reason).toContain("operator stop");
  expect(r.calls.submit).toBe(0);
});

test("a fatal decider failure ends the run with no motion", async () => {
  const r = rig();
  const { DecideFailure } = await import("./jev");
  const summary = await runDecisionLoop(
    {
      ...r.deps(),
      decider: {
        strategy: "choice",
        decide: () => Promise.reject(new DecideFailure("billing", "no credit")),
      },
    },
    options()
  );
  expect(summary.end_reason).toBe("decider_billing");
  expect(r.calls.submit).toBe(0);
});

test("failed steps that still move most of the way count as progress, not a stall", async () => {
  const r = rig("partial");
  const summary = await runDecisionLoop(r.deps(), options({ maxSteps: 12 }));
  expect(summary.end_reason).not.toBe("repeated_failures");
  expect(summary.partial).toBeGreaterThanOrEqual(3);
  expect(r.measured().gripper).toBeGreaterThan(32);
});
