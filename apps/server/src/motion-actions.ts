import { Joint, Operation } from "@robo/domain";
import type { Lease, Observation } from "@robo/domain";
import type { MoveInput } from "@robo/protocol";
import { Effect, Schema } from "effect";

import { describeToolError, FailureCode, ToolFailure } from "./tool-errors";

export const ActionResult = Schema.Struct({
  status: Schema.Literals(["completed", "cancelled", "failed", "unknown"]),
  request_id: Schema.String,
  operation: Schema.NullOr(Operation),
  message: Schema.String,
  code: Schema.optionalKey(FailureCode),
});
export type ActionResult = typeof ActionResult.Type;
type ActionInput = Omit<MoveInput, "request_id">;

export interface ActionRecord {
  id: string;
  owner: string;
  requestId: string;
  input: ActionInput;
  bootId: string | null;
  result: ActionResult | null;
}
export interface ActionLedger {
  get: (id: string) => ActionRecord | null;
  save: (record: ActionRecord) => void;
}
export interface MotionIO {
  observe: (signal: AbortSignal) => Promise<Observation>;
  acquire: (
    owner: string,
    observation: Observation,
    signal: AbortSignal
  ) => Promise<Lease>;
  renew: (lease: Lease, signal: AbortSignal) => Promise<Lease>;
  submit: (
    lease: Lease,
    input: MoveInput,
    signal: AbortSignal
  ) => Promise<Operation>;
  operation: (id: string, signal: AbortSignal) => Promise<Operation>;
  find: (
    owner: string,
    requestId: string,
    bootId: string,
    signal: AbortSignal
  ) => Promise<Operation | null>;
  release: (lease: Lease) => Promise<void>;
  cancel: (owner: string, bootId: string) => Promise<void>;
  rejected: (error: unknown) => boolean;
}
export interface MotionProgress {
  action_id: string;
  phase: "acquiring" | "moving" | "reconciling" | "finished";
  operation: Operation | null;
  result?: ActionResult;
}
export interface ActionRequest {
  id: string;
  owner: string;
  input: ActionInput;
  signal: AbortSignal;
  progress: (event: MotionProgress) => void;
  assertCurrent?: () => void;
}
const terminalStatus = (
  operation: Operation | null
): ActionResult["status"] => {
  switch (operation?.status) {
    case "completed":
    case "cancelled":
    case "failed": {
      return operation.status;
    }
    case undefined:
    case "accepted":
    case "running": {
      return "unknown";
    }
  }
};
const isTerminal = (operation: Operation): boolean =>
  terminalStatus(operation) !== "unknown";
const validateTarget = (input: ActionInput, observation: Observation): void => {
  if (observation.age_ms > 250 || observation.fault) {
    throw new ToolFailure({
      code: "UNSAFE_TARGET",
      detail: "Robot observation is stale or faulted; observe again.",
    });
  }
  if (observation.control_epoch === undefined) {
    throw new ToolFailure({
      code: "CAPABILITY_UNAVAILABLE",
      detail:
        "The motor service needs guarded action support before chat can move.",
    });
  }
  if (observation.operator && observation.operator.remaining_ms > 0) {
    throw new ToolFailure({
      code: "CONTROL_BUSY",
      detail: "Another controller owns the robot. Do not take over.",
    });
  }
  if (input.xyz && !observation.cartesian) {
    throw new ToolFailure({
      code: "CAPABILITY_UNAVAILABLE",
      detail: "Cartesian motion has not been commissioned.",
    });
  }
  if (input.target) {
    for (const [name, value] of Object.entries(input.target)) {
      const joint = Schema.decodeUnknownSync(Joint)(name),
        [min, max] = observation.limits[joint];
      if (
        value < min ||
        value > max ||
        Math.abs(value - observation.measured[joint]) >
          observation.max_step + 1e-8
      ) {
        throw new ToolFailure({
          code: "UNSAFE_TARGET",
          detail: `${joint} target exceeds commissioned limits or maximum step. Observe and choose a smaller move.`,
        });
      }
    }
  }
};

// A single executor owns admission for the robot. It never queues a second
// motion behind a running action, and never retries a submission with a new ID.
const defaultTiming = { pollMs: 100, renewMs: 500, marginMs: 5000 };

export const createMotionExecutor = (
  io: MotionIO,
  ledger: ActionLedger,
  timing = defaultTiming
) => {
  let busy = false;
  const execute = async (request: ActionRequest): Promise<ActionResult> => {
    request.signal.throwIfAborted();
    request.assertCurrent?.();
    const saved = ledger.get(request.id);
    if (saved) {
      if (JSON.stringify(saved.input) !== JSON.stringify(request.input)) {
        throw new ToolFailure({
          code: "INVALID_INPUT",
          detail: "Action identity was reused with different motion.",
        });
      }
      return (
        saved.result ?? {
          status: "unknown",
          request_id: saved.requestId,
          operation: null,
          message:
            "This action was already admitted. Reconcile its original request; do not repeat the motion.",
        }
      );
    }
    if (busy) {
      throw new ToolFailure({
        code: "MOTION_BUSY",
        detail:
          "A motion action is already executing. Wait for its measured result.",
      });
    }
    busy = true;
    const record: ActionRecord = {
      id: request.id,
      owner: request.owner,
      input: request.input,
      requestId: crypto.randomUUID(),
      bootId: null,
      result: null,
    };
    let operation: Operation | null = null;
    let lease: Lease | null = null;
    let terminalConfirmed = false;
    let submitted = false;
    let cleanupFailed = false;
    let lastPhase: MotionProgress["phase"] | null = null;
    let lastProgress = 0;
    const progress = (phase: MotionProgress["phase"]) => {
      if (phase === lastPhase && performance.now() - lastProgress < 500) {
        return;
      }
      lastPhase = phase;
      lastProgress = performance.now();
      request.progress({ action_id: record.id, phase, operation });
    };
    const call = <A>(fn: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({
        try: (signal) => fn(AbortSignal.any([signal, request.signal])),
        catch: (error) => error,
      });
    const heartbeat = Effect.fn("Motion.heartbeat")(function* heartbeat(
      owned: Lease
    ) {
      while (true) {
        yield* call((signal) => io.renew(owned, signal)).pipe(
          Effect.mapError(
            () =>
              new ToolFailure({
                code: "CONTROL_REVOKED",
                detail:
                  "Lease renewal failed. Motion supervision stopped; control will not be reacquired.",
              })
          )
        );
        yield* Effect.sleep(timing.renewMs);
      }
    });
    const motion = Effect.fn("Motion.execute")(function* motion() {
      const observation = yield* call((signal) => io.observe(signal));
      request.assertCurrent?.();
      validateTarget(request.input, observation);
      record.bootId = observation.boot_id;
      ledger.save(record);
      // Register before acquisition: a cancelled or lost acquire response still
      // invalidates the guarded request at the motor owner.
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          try {
            await (terminalConfirmed && lease
              ? io.release(lease)
              : io.cancel(record.owner, observation.boot_id));
          } catch {
            cleanupFailed = true;
          }
        })
      );
      progress("acquiring");
      lease = yield* call((signal) =>
        io.acquire(record.owner, observation, signal)
      );
      const owned = lease,
        track = Effect.fn("Motion.track")(function* track() {
          request.assertCurrent?.();
          submitted = true;
          operation = yield* call((signal) =>
            io.submit(
              owned,
              { ...record.input, request_id: record.requestId },
              signal
            )
          ).pipe(
            Effect.catch((error) =>
              io.rejected(error)
                ? Effect.suspend(() => {
                    submitted = false;
                    return Effect.fail(
                      new ToolFailure({
                        code: "MOTION_FAILED",
                        detail: describeToolError(error).message,
                      })
                    );
                  })
                : Effect.succeed(null)
            )
          );
          while (true) {
            progress(operation ? "moving" : "reconciling");
            if (operation && isTerminal(operation)) {
              terminalConfirmed = true;
              return operation;
            }
            yield* Effect.sleep(timing.pollMs);
            const previous = operation;
            operation = yield* call((signal) =>
              previous
                ? io.operation(previous.id, signal)
                : io.find(
                    record.owner,
                    record.requestId,
                    observation.boot_id,
                    signal
                  )
            );
          }
        });
      return yield* Effect.raceFirst(track(), heartbeat(owned));
    });
    try {
      ledger.save(record);
      await Effect.runPromise(
        motion().pipe(
          Effect.scoped,
          Effect.timeout(record.input.duration_s * 1000 + timing.marginMs)
        ),
        { signal: request.signal }
      );
    } catch (error) {
      // Cleanup has run and stopped renewal. Reconcile once with a separate,
      // bounded signal so a cancelled chat can still journal the actual result.
      if (record.bootId) {
        try {
          operation = await io.find(
            record.owner,
            record.requestId,
            record.bootId,
            AbortSignal.timeout(2000)
          );
        } catch {
          /* Preserve an unknown outcome when the motor service is unavailable. */
        }
      }
      const failure = describeToolError(error),
        message = request.signal.aborted
          ? describeToolError(request.signal.reason).message
          : describeToolError(error).message;
      record.result = {
        status:
          operation && isTerminal(operation)
            ? terminalStatus(operation)
            : submitted
              ? "unknown"
              : request.signal.aborted
                ? "cancelled"
                : "failed",
        request_id: record.requestId,
        operation,
        message:
          operation && isTerminal(operation)
            ? `${operation.status}: ${operation.reason ?? message}`
            : submitted
              ? `OUTCOME_UNKNOWN: ${message} The original request will not be resubmitted.`
              : message,
      };
      if (record.result.status !== "completed") {
        record.result = {
          ...record.result,
          code:
            record.result.status === "unknown"
              ? "OUTCOME_UNKNOWN"
              : record.result.status === "cancelled"
                ? "CANCELLED"
                : operation?.status === "failed"
                  ? "MOTION_FAILED"
                  : failure.code,
        };
      }
    } finally {
      busy = false;
    }
    if (!record.result) {
      record.result = {
        status:
          operation && isTerminal(operation)
            ? terminalStatus(operation)
            : "unknown",
        request_id: record.requestId,
        operation,
        message:
          operation?.status === "completed"
            ? "Motion reached measured completion."
            : `Motion ${operation?.status ?? "outcome unknown"}: ${operation?.reason ?? "No measured completion"}`,
      };
    }
    if (cleanupFailed) {
      record.result = {
        ...record.result,
        message:
          record.result.message +
          " Ownership cleanup was not confirmed; renewal has stopped and the lease expires within three seconds of its last renewal.",
      };
    }
    ledger.save(record);
    request.progress({
      action_id: record.id,
      phase: "finished",
      operation,
      result: record.result,
    });
    return record.result;
  };
  return { execute };
};
