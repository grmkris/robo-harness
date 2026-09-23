import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Frame, Observation } from "@robo/domain";
import { Schema } from "effect";

import { captureEvidence } from "./bench-evidence";

const base64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAQUCcf/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8BP//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8BP//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEABj8Cf//Z";

const frame = (camera: "workspace" | "wrist", seq: number) =>
  Schema.decodeUnknownSync(Frame)({
    id: `${camera}-${seq}`,
    camera,
    seq,
    monotonic_s: seq,
    wall_time_ms: seq,
    clock_domain: "fixture",
    age_ms: 1,
    width: 1,
    height: 1,
    media_type: "image/jpeg",
    base64,
  });

const observation = Schema.decodeUnknownSync(Observation)({
  boot_id: "boot",
  control_epoch: 1,
  seq: 1,
  monotonic_s: 1,
  wall_time_ms: 1,
  clock_domain: "fixture",
  age_ms: 1,
  units: {},
  backend: "mock",
  calibration_id: "fixture",
  measured: {
    shoulder_pan: 0,
    shoulder_lift: 0,
    elbow_flex: 0,
    wrist_flex: 0,
    wrist_roll: 0,
    gripper: 0,
  },
  commanded: {
    shoulder_pan: 0,
    shoulder_lift: 0,
    elbow_flex: 0,
    wrist_flex: 0,
    wrist_roll: 0,
    gripper: 0,
  },
  temperatures: {},
  ee: [],
  frames: {},
  cameras: {},
  operator: null,
  operation: null,
  fault: null,
  limits: {
    shoulder_pan: [-1, 1],
    shoulder_lift: [-1, 1],
    elbow_flex: [-1, 1],
    wrist_flex: [-1, 1],
    wrist_roll: [-1, 1],
    gripper: [0, 100],
  },
  max_step: 1,
  cartesian: false,
  trajectory: [],
});

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

test("captureEvidence stores original bytes, hashes and paired observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bench-evidence-"));
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as { camera?: "workspace" | "wrist" };
      return Response.json(
        request.url.includes("/observe")
          ? observation
          : frame(body.camera ?? "workspace", 2)
      );
    },
  });
  servers.push(server);
  try {
    const result = await captureEvidence({
      directory: join(directory, "trial-00"),
      baseUrl: `http://127.0.0.1:${String(server.port)}`,
    });
    expect(result.status).toBe("captured");
    expect(
      (await readFile(join(directory, "trial-00/workspace.jpg"))).toString(
        "base64"
      )
    ).toBe(base64);
    expect(
      await readFile(join(directory, "trial-00/workspace.json"), "utf-8")
    ).not.toContain(base64);
    expect(
      await readFile(join(directory, "trial-00/capture.json"), "utf-8")
    ).toContain("sha256");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("captureEvidence refuses wrong-role frames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bench-evidence-"));
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (request.url.includes("/observe")) return Response.json(observation);
      return Response.json(frame("workspace", 2));
    },
  });
  servers.push(server);
  try {
    const failure = await captureEvidence({
      directory: join(directory, "trial-01"),
      baseUrl: `http://127.0.0.1:${String(server.port)}`,
    }).catch((error: unknown) => error);
    expect(String(failure)).toContain("wrong camera");
    expect(
      await readFile(join(directory, "trial-01/capture-failed.json"), "utf-8")
    ).toContain("incomplete");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("captureEvidence refuses stale frames and preserves an existing capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bench-evidence-"));
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      seen.push(new URL(request.url).pathname);
      const body = Schema.decodeUnknownSync(
        Schema.Struct({
          camera: Schema.optionalKey(Schema.Literals(["workspace", "wrist"])),
        })
      )(await request.json());
      if (request.url.includes("/observe")) return Response.json(observation);
      return Response.json({
        ...frame(body.camera ?? "workspace", 2),
        age_ms: 501,
      });
    },
  });
  servers.push(server);
  try {
    const options = {
      directory: join(directory, "trial-02"),
      baseUrl: `http://127.0.0.1:${String(server.port)}`,
    };
    const stale = await captureEvidence(options).catch(
      (error: unknown) => error
    );
    expect(String(stale)).toContain("stale");
    const prior = await readFile(
      join(options.directory, "capture-failed.json"),
      "utf-8"
    );
    const requests = seen.length;
    const duplicate = await captureEvidence(options).catch(
      (error: unknown) => error
    );
    expect(String(duplicate)).toContain("EEXIST");
    expect(seen.length).toBe(requests);
    expect(
      await readFile(join(options.directory, "capture-failed.json"), "utf-8")
    ).toBe(prior);
    expect(
      seen.every(
        (path) => path === "/api/tool/observe" || path === "/api/tool/capture"
      )
    ).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
