import { expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["ROBO_DATA_DIR"] = mkdtempSync(join(tmpdir(), "robo-recordings-"));

// The robot module talks to the motor owner over the tailnet; the sample path
// under test only needs an observation and two camera frames.
const state = {
  stale: false,
  clock_domain: "boot-1",
  boot_id: "boot-1",
};
const frame = (camera: string) => ({
  id: `boot-1:${camera}:1`,
  camera,
  seq: 1,
  monotonic_s: 10,
  wall_time_ms: 1000,
  clock_domain: state.clock_domain,
  width: 4,
  height: 4,
  media_type: "image/jpeg",
  base64: "",
  age_ms: 20,
  calibration: null,
});
mock.module("./robot", () => ({
  ApiError: class ApiError extends Error {},
  clock: { offset_ms: 0, uncertainty_ms: 1, domain: "boot-1" },
  frames: () => ({ workspace: frame("workspace"), wrist: frame("wrist") }),
  freshObservation: () => {
    if (state.stale) {
      throw new Error("Robot observation is stale or unavailable");
    }
    return {
      age_ms: 30,
      boot_id: state.boot_id,
      clock_domain: state.clock_domain,
      monotonic_s: 10,
      measured: {},
      commanded: {},
      limits: {},
    };
  },
}));

const recordings = await import("./recordings");

test("a transient stale observation is counted, not fatal", async () => {
  const record = await recordings.startRecording("transient misses");
  await recordings.recordSample();
  expect(record.frames).toBe(1);

  state.stale = true;
  for (let i = 0; i < 20; i += 1) {
    await recordings.recordSample();
  }
  expect(record.state).toBe("recording");
  expect(record.error).toBeNull();
  expect(record.frames).toBe(1);

  // Recovery resumes sampling, and the missed samples are still reported.
  state.stale = false;
  await recordings.recordSample();
  expect(record.frames).toBe(2);

  const stopped = await recordings.stopRecording();
  expect(stopped.state).toBe("incomplete");
  expect(stopped.error).toContain("20 sample deadlines were missed");
});

test("a stale observation that never recovers ends the recording", async () => {
  const record = await recordings.startRecording("persistent misses");
  state.stale = true;
  for (let i = 0; i < 60; i += 1) {
    await recordings.recordSample();
  }
  expect(record.state).toBe("incomplete");
  expect(record.error).toContain("consecutive samples");
  state.stale = false;
  await recordings.stopRecording();
});

test("a motor service restart stops the recording immediately", async () => {
  const record = await recordings.startRecording("restart");
  await recordings.recordSample();
  state.boot_id = "boot-2";
  await recordings.recordSample();
  expect(record.state).toBe("incomplete");
  expect(record.error).toContain("motor service restarted");
  state.boot_id = "boot-1";
  await recordings.stopRecording();
});
