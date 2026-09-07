import { expect, test } from "bun:test";

import type { Frame, Observation } from "@robo/domain";

import { startHarness, tokens } from "./harness";

const pose = {
  shoulder_pan: 0,
  shoulder_lift: 0,
  elbow_flex: 0,
  wrist_flex: 0,
  wrist_roll: 0,
  gripper: 40,
};
const observation = (seq: number): Observation => ({
  boot_id: "sampling-fixture",
  seq,
  monotonic_s: performance.now() / 1000,
  wall_time_ms: Date.now(),
  server_time_ms: Date.now(),
  clock_domain: "sampling-fixture",
  age_ms: 0,
  units: {},
  backend: "mock",
  calibration_id: "mock-v1",
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
const frame = (camera: string, seq: number): Frame => ({
  id: `${camera}-${seq}`,
  camera,
  seq,
  monotonic_s: performance.now() / 1000,
  wall_time_ms: Date.now(),
  clock_domain: "sampling-fixture",
  age_ms: 0,
  width: 1,
  height: 1,
  media_type: "image/jpeg",
  base64: "",
});

// Gates hold an I/O response open while the other streams keep ticking. No
// motor device, provider, or deployed service is involved in these fixtures.
test("a pending camera cannot block observations or the other camera", async () => {
  const gate = Promise.withResolvers<boolean>();
  let seq = 0;
  let wristSeq = 0;
  let blockedRequests = 0;
  const io = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/frames/workspace") {
        blockedRequests += 1;
        await gate.promise;
        return Response.json(frame("workspace", blockedRequests));
      }
      if (path === "/frames/wrist") {
        wristSeq += 1;
        return Response.json(frame("wrist", wristSeq));
      }
      seq += 1;
      return Response.json(observation(seq));
    },
  });
  const h = await startHarness({
    withIo: false,
    ioUrl: `http://127.0.0.1:${io.port}`,
  });
  try {
    await h.until(async () => {
      const packet = await (
        await h.request("/api/telemetry", undefined, tokens.worker)
      ).json();
      return packet.observation?.seq >= 3 && packet.frames.wrist?.seq >= 3;
    }, 1500);
    expect(blockedRequests).toBe(1);
    expect((await h.call("observe")).status).toBe(200);
  } finally {
    gate.resolve(true);
    await h.close();
    await io.stop(true);
  }
}, 15_000);

test("old responses include their transit time in observation freshness", async () => {
  const gate = Promise.withResolvers<boolean>();
  let seq = 0;
  const sent = observation(1);
  const io = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/observe") {
        seq += 1;
        if (seq === 1) {
          // A synthetic response generated before a slow transfer.
          await Bun.sleep(350);
          return Response.json(sent);
        }
        await gate.promise;
      }
      return Response.json(observation(seq));
    },
  });
  const h = await startHarness({
    withIo: false,
    ioUrl: `http://127.0.0.1:${io.port}`,
  });
  try {
    await h.until(async () => (await h.status()).observation?.seq === 1);
    const result = await h.call("observe");
    expect(result.status).toBe(503);
    expect(result.data.error).toContain("stale");
  } finally {
    gate.resolve(true);
    await h.close();
    await io.stop(true);
  }
}, 15_000);

test("cached camera frames continue aging while their next request is pending", async () => {
  const gate = Promise.withResolvers<boolean>();
  let seq = 0;
  const counts = new Map<string, number>();
  const io = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/frames/")) {
        const camera = path.slice(8);
        const count = (counts.get(camera) ?? 0) + 1;
        counts.set(camera, count);
        if (count > 1) await gate.promise;
        return Response.json(frame(camera, count));
      }
      seq += 1;
      return Response.json(observation(seq));
    },
  });
  const h = await startHarness({
    withIo: false,
    ioUrl: `http://127.0.0.1:${io.port}`,
  });
  try {
    await h.until(async () => {
      const packet = await (
        await h.request("/api/telemetry", undefined, tokens.worker)
      ).json();
      return packet.observation?.seq >= 8 && packet.frames.wrist?.age_ms > 500;
    }, 1500);
    expect(counts.get("wrist")).toBe(2);
    expect(counts.get("workspace")).toBe(2);
  } finally {
    gate.resolve(true);
    await h.close();
    await io.stop(true);
  }
}, 15_000);
