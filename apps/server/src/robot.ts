import type { Observation, Frame, Joint, Lease, Operation } from "@robo/domain";
import type { moveSchema } from "@robo/protocol";
import type { z } from "zod";

import { config } from "./config";
import { emit } from "./store";

export type MoveInput = z.infer<typeof moveSchema>;
export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}
async function io<T>(
  path: string,
  body?: unknown,
  timeoutMs = 2000
): Promise<T> {
  const res = await fetch(config.ioUrl + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${config.ioToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? null : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json()) as T & { error?: string; detail?: unknown };
  if (!res.ok) {
    throw new ApiError(data.error ?? "Robot request failed", res.status);
  }
  return data;
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
export let currentFrames: Partial<Record<string, Frame>> = {};
export let robotError: string | null = "Waiting for robot service";
export let receivedAt = 0;
export let clock = { offset_ms: 0, uncertainty_ms: 0, domain: "" };
export async function sample() {
  const sent = Date.now();
  const [o, workspace, wrist] = await Promise.allSettled([
    io<Observation>("/observe"),
    io<Frame>("/frames/workspace"),
    io<Frame>("/frames/wrist"),
  ]);
  const received = Date.now();
  if (o.status === "rejected") {
    robotError =
      o.reason instanceof Error ? o.reason.message : "Robot unavailable";
    return;
  }
  const prev = current;
  current = o.value;
  receivedAt = received;
  robotError = null;
  clock = {
    offset_ms:
      (sent + received) / 2 - (current.server_time_ms ?? current.wall_time_ms),
    uncertainty_ms: (received - sent) / 2,
    domain: current.clock_domain,
  };
  currentFrames = {};
  for (const [name, result] of [
    ["workspace", workspace],
    ["wrist", wrist],
  ] as const) {
    if (result.status === "fulfilled") {
      currentFrames[name] = result.value;
    }
  }
  if (prev?.boot_id !== current.boot_id) {
    controllers.clear();
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
  if (
    !current ||
    Date.now() - receivedAt > 500 ||
    current.age_ms > 250 ||
    robotError
  ) {
    throw new ApiError("Robot observation is stale or unavailable", 503);
  }
  const elapsed = Date.now() - receivedAt;
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
  return await io<Frame>(
    `/frames/${encodeURIComponent(
      camera
    )}${frameId ? "?frame_id=" + encodeURIComponent(frameId) : ""}`
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
  const lease = await io<Lease>("/control/acquire", { owner, mode, takeover });
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
  const lease = await io<Lease>("/control/renew", {
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
    return await io("/control/release", { owner, lease_id: c.lease.lease_id });
  } finally {
    controllers.delete(owner);
  }
}
export async function move(owner: string, body: MoveInput) {
  refuseWhileStopping();
  const c = liveController(owner);
  if (body.target) {
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
  const op = await io<Operation>("/operations", {
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
  stopping = true;
  try {
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await io<Observation>("/control/stop", {}, 1500);
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
  io<Operation>(`/operations/${encodeURIComponent(id)}`);
