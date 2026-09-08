import { Frame, Lease, Observation, Operation, type Joint } from "@robo/domain";
import type { MoveInput } from "@robo/protocol";
import { Schema } from "effect";

import { config } from "./config";
import { revokeAgentControl } from "./control-lifecycle";
import type { MotionIO } from "./motion-actions";
import { emit } from "./store";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}
async function io<S extends Schema.Codec<any>>(
  path: string,
  schema: S,
  body?: unknown,
  timeoutMs = 2000,
  signal?: AbortSignal
): Promise<S["Type"]> {
  const res = await fetch(config.ioUrl + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${config.ioToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? null : JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
  });
  const data: unknown = await res.json();
  if (!res.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : "Robot request failed";
    throw new ApiError(message, res.status);
  }
  try {
    return Schema.decodeUnknownSync(schema)(data);
  } catch (error) {
    console.error(
      `Malformed response from ${path}:`,
      error instanceof Error ? error.message : String(error)
    );
    throw new ApiError("Robot service returned an unexpected response", 502);
  }
}
interface Controller {
  lease: Lease;
  owner: string;
  mode: string;
  expires: number;
}
const controllers = new Map<string, Controller>();
let stopping = false;
const refuseWhileStopping = () => {
  if (stopping) {
    throw new ApiError("A stop is in progress", 409);
  }
};
export let current: Observation | null = null;
const cachedFrames = new Map<string, { frame: Frame; received: number }>();
const samplingCameras = new Set<string>();
let observationReceived = 0;

export function frames(): Partial<Record<string, Frame>> {
  const now = performance.now();
  return Object.fromEntries(
    [...cachedFrames].map(([name, cached]) => [
      name,
      {
        ...cached.frame,
        age_ms: cached.frame.age_ms + Math.max(0, now - cached.received),
      },
    ])
  );
}

// Each camera has one independent in-flight request. A slow camera must not
// delay motor observations, the other camera, or reset an older frame's age.
export async function sampleCamera(camera: string): Promise<void> {
  if (samplingCameras.has(camera)) return;
  samplingCameras.add(camera);
  const sent = performance.now();
  try {
    const frame = await io(`/frames/${encodeURIComponent(camera)}`, Frame);
    const received = performance.now();
    if (current && frame.clock_domain !== current.clock_domain) return;
    cachedFrames.set(camera, {
      frame: { ...frame, age_ms: frame.age_ms + received - sent },
      received,
    });
  } catch {
    cachedFrames.delete(camera);
  } finally {
    samplingCameras.delete(camera);
  }
}
export let robotError: string | null = "Waiting for robot service";
export let receivedAt = 0;
export let clock = { offset_ms: 0, uncertainty_ms: 0, domain: "" };
export async function sample() {
  const sent = Date.now();
  const started = performance.now();
  let observation: Observation;
  try {
    observation = await io("/observe", Observation);
  } catch (error) {
    robotError = error instanceof Error ? error.message : "Robot unavailable";
    return;
  }
  const received = Date.now();
  observationReceived = performance.now();
  // The device age excludes transport. The full round trip is a conservative
  // upper bound on that uncertainty, independent of the hosts' wall clocks.
  const transit = observationReceived - started;
  const prev = current;
  current = {
    ...observation,
    age_ms: observation.age_ms + transit,
    operator: observation.operator
      ? {
          ...observation.operator,
          remaining_ms: Math.max(
            0,
            observation.operator.remaining_ms - transit
          ),
        }
      : null,
  };
  receivedAt = received;
  robotError = null;
  clock = {
    offset_ms:
      (sent + received) / 2 - (current.server_time_ms ?? current.wall_time_ms),
    uncertainty_ms: transit / 2,
    domain: current.clock_domain,
  };
  if (prev?.boot_id !== current.boot_id) {
    if (prev) revokeAgentControl("Robot restarted");
    controllers.clear();
    for (const [camera, cached] of cachedFrames) {
      if (cached.frame.clock_domain !== current.clock_domain)
        cachedFrames.delete(camera);
    }
    emit("robot.connected", {
      backend: current.backend,
      boot_id: current.boot_id,
    });
  }
  if (
    current.operation &&
    JSON.stringify(prev?.operation) !== JSON.stringify(current.operation) &&
    prev?.operation?.status !== current.operation.status
  ) {
    emit("motion.status", { ...current.operation });
  }
  if (current.fault && prev?.fault !== current.fault) {
    emit("robot.fault", { message: current.fault });
  }
}
export function freshObservation() {
  const elapsed = Math.max(0, performance.now() - observationReceived);
  if (!current || current.age_ms + elapsed > 250 || robotError) {
    throw new ApiError("Robot observation is stale or unavailable", 503);
  }
  return {
    ...current,
    age_ms: current.age_ms + elapsed,
    operator:
      current.operator && current.operator.remaining_ms > elapsed
        ? {
            ...current.operator,
            remaining_ms: current.operator.remaining_ms - elapsed,
          }
        : null,
  };
}
export async function capture(camera: string, frameId?: string) {
  return await io(
    `/frames/${encodeURIComponent(
      camera
    )}${frameId ? "?frame_id=" + encodeURIComponent(frameId) : ""}`,
    Frame
  );
}
export async function acquire(
  owner: string,
  mode: string,
  takeover: boolean,
  human: boolean
) {
  if (!human && (mode !== "agent" || takeover)) {
    throw new ApiError(
      "Only a human operator can take over or enable leader mode",
      403
    );
  }
  refuseWhileStopping();
  if (human && (mode !== "agent" || takeover))
    revokeAgentControl("Human operator took control");
  const lease = await io("/control/acquire", Lease, {
    owner,
    mode,
    takeover,
  });
  if (takeover) {
    controllers.clear();
  }
  controllers.set(owner, {
    lease,
    owner,
    mode,
    expires: Date.now() + lease.ttl_ms,
  });
  emit("control.acquired", { owner, mode, takeover });
  return lease;
}
// A lease the robot has already expired must never be presented again: the Python
// engine would refuse it, but refusing here keeps the wire quiet and the error precise.
function liveController(owner: string) {
  const c = controllers.get(owner);
  if (!c) {
    throw new ApiError("Acquire control first");
  }
  if (c.expires <= Date.now()) {
    controllers.delete(owner);
    throw new ApiError("Control lease expired; acquire control again", 409);
  }
  return c;
}
export async function renew(owner: string) {
  const c = liveController(owner);
  const lease = await io("/control/renew", Lease, {
    owner,
    lease_id: c.lease.lease_id,
  });
  c.expires = Date.now() + lease.ttl_ms;
  return lease;
}
export async function release(owner: string) {
  const c = controllers.get(owner);
  if (!c) {
    return { released: true };
  }
  try {
    return await io("/control/release", Schema.Unknown, {
      owner,
      lease_id: c.lease.lease_id,
    });
  } finally {
    controllers.delete(owner);
  }
}
export async function move(owner: string, body: MoveInput) {
  refuseWhileStopping();
  const c = liveController(owner);
  if (body.target !== undefined) {
    // The observation carries the commissioned limits; a target outside them is
    // refused before it reaches the motor owner, naming the joint.
    const { limits } = freshObservation();
    for (const [joint, value] of Object.entries(body.target) as [
      Joint,
      number,
    ][]) {
      const range = limits[joint];
      if (!range) {
        throw new ApiError("Unknown joint " + joint, 422);
      }
      const [min, max] = range;
      if (value < min || value > max) {
        throw new ApiError(
          `Target for ${joint} (${value}) is outside the commissioned range ${min}..${max}`,
          422
        );
      }
    }
  }
  const op = await io("/operations", Operation, {
    ...body,
    owner,
    lease_id: c.lease.lease_id,
  });
  emit("motion.submitted", { ...op });
  return op;
}
// Stop is retried because it is the one call that must not fail on a hiccup.
// Local leases are revoked whether or not the robot confirmed: with no
// heartbeat left, the motor owner cancels motion when the lease expires.
export async function stop() {
  revokeAgentControl("Stopped by operator");
  stopping = true;
  try {
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await io("/control/stop", Observation, {}, 1500);
        controllers.clear();
        emit("control.stopped", {});
        return result;
      } catch (error) {
        failure = error;
      }
    }
    controllers.clear();
    const message =
      failure instanceof Error ? failure.message : "Robot did not answer";
    emit("control.stop_failed", { message });
    throw new ApiError(
      `Robot did not confirm the stop (${
        message
      }); local control is revoked and motion expires with the lease`,
      502
    );
  } finally {
    stopping = false;
  }
}
export const operation = (id: string) =>
  io(`/operations/${encodeURIComponent(id)}`, Operation);

// Action leases stay scoped to the executor; they never enter the manual
// controller map. Every request still reaches the single Python motor owner.
export const motionIO: MotionIO = {
  observe: async (signal) => {
    const started = performance.now();
    const value = await io("/observe", Observation, undefined, 2000, signal);
    return { ...value, age_ms: value.age_ms + performance.now() - started };
  },
  acquire: (owner, observation, signal) =>
    io(
      "/control/acquire",
      Lease,
      {
        owner,
        mode: "agent",
        takeover: false,
        expected_boot_id: observation.boot_id,
        expected_control_epoch: observation.control_epoch,
      },
      2000,
      signal
    ),
  renew: (lease, signal) =>
    io(
      "/control/renew",
      Lease,
      {
        owner: lease.owner,
        lease_id: lease.lease_id,
      },
      1000,
      signal
    ),
  submit: (lease, input, signal) =>
    io(
      "/operations",
      Operation,
      {
        ...input,
        owner: lease.owner,
        lease_id: lease.lease_id,
      },
      2000,
      signal
    ),
  operation: (id, signal) =>
    io(
      `/operations/${encodeURIComponent(id)}`,
      Operation,
      undefined,
      2000,
      signal
    ),
  find: (owner, requestId, bootId, signal) =>
    io(
      `/operations/request?${new URLSearchParams({ owner, request_id: requestId, boot_id: bootId })}`,
      Schema.NullOr(Operation),
      undefined,
      2000,
      signal
    ),
  release: async (lease) => {
    await io("/control/release", Schema.Unknown, {
      owner: lease.owner,
      lease_id: lease.lease_id,
    });
  },
  cancel: async (owner, bootId) => {
    await io("/control/cancel-owner", Schema.Unknown, {
      owner,
      boot_id: bootId,
    });
  },
  rejected: (error) => error instanceof ApiError && error.status < 500,
};
