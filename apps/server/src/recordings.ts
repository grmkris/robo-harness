import { createHash } from "node:crypto";
import {
  mkdir,
  writeFile,
  appendFile,
  statfs,
  readFile,
  rename,
} from "node:fs/promises";
import { join } from "node:path";

import type { AppEvent } from "@robo/domain";

import { config } from "./config";
import {
  freshObservation,
  recentObservation,
  frames,
  clock,
  ApiError,
} from "./robot";
import { db, emit } from "./store";

export interface Recording {
  id: string;
  label: string;
  state: string;
  path: string;
  created: number;
  finished: number | null;
  frames: number;
  error: string | null;
}
export let active: Recording | null = null;
let writing = false;
let skipped = 0;
let stopping = false;
let stopPending: Promise<Recording> | null = null;
let eventTail = Promise.resolve();
let pendingEvents = 0;
let bootId = "";
const markIncomplete = (record: Recording, message: string) => {
  if (record.error) return;
  record.state = "incomplete";
  record.error = message;
  db.query("UPDATE recordings SET state='incomplete',error=? WHERE id=?").run(
    message,
    record.id
  );
  emit("recording.error", { id: record.id, message });
};
const known = new Set<string>();
// A recording is telemetry, not an admission decision: one stale observation
// or camera hiccup must not end it. Over the tailnet the observation age sits
// at 223 ms p95 against the 250 ms gate, which killed a recording within
// seconds (2026-09-17). Only a miss that persists this many consecutive
// samples -- five seconds at 10 Hz -- ends the recording.
const MISS_LIMIT = 50;
// Below this achieved sample rate a recording is not worth replaying.
const MIN_FPS = 4;
let consecutiveMisses = 0;
/** A miss worth counting and retrying, as opposed to a reason to stop. */
class TransientMiss extends Error {}
export function noteMissedSample() {
  if (active?.state === "recording") {
    skipped++;
  }
}
export const recordings = () =>
  db
    .query("SELECT * FROM recordings ORDER BY created DESC LIMIT 100")
    .all() as Recording[];
export async function startRecording(label: string) {
  if (active) {
    throw new ApiError("A recording is already active");
  }
  // Starting a recording commands nothing, so it does not need a
  // motion-grade observation; over the tailnet that gate refused half the
  // starts (2026-09-17).
  const obs = recentObservation(1000);
  const id = crypto.randomUUID();
  const path = join(config.dataDir, "recordings", id);
  const created = Date.now();
  active = {
    id,
    label,
    state: "starting",
    path,
    created,
    finished: null,
    frames: 0,
    error: null,
  };
  try {
    await mkdir(join(path, "images"), { recursive: true });
    await mkdir(join(path, "programs"), { recursive: true });
    const stat = await statfs(path);
    if (stat.bavail * stat.bsize < 512 * 1024 * 1024) {
      throw new ApiError("Less than 512 MiB storage available", 507);
    }
    const urdf = await readFile(`${config.root}/assets/so101.urdf`);
    await writeFile(
      `${path}/manifest.json`,
      JSON.stringify(
        {
          version: 2,
          time_axis: "observation.monotonic_s",
          action_semantics:
            "sampled commanded joint positions; not measured applied motor actions",
          id,
          label,
          created,
          backend: obs.backend,
          calibration_id: obs.calibration_id,
          units: obs.units,
          clock_domain: obs.clock_domain,
          urdf_sha256: createHash("sha256").update(urdf).digest("hex"),
          sampling_fps: 10,
          state: "recording",
          dataset:
            "Export with robo-export; raw samples preserve actual capture timestamps",
        },
        null,
        2
      )
    );
    bootId = obs.boot_id;
    eventTail = Promise.resolve();
    pendingEvents = 0;
    active.state = "recording";
    db.query(
      "INSERT INTO recordings(id,label,state,path,created) VALUES(?,?,?,?,?)"
    ).run(id, label, "recording", path, created);
    known.clear();
    skipped = 0;
    consecutiveMisses = 0;
    stopping = false;
    emit("recording.started", { id, label });
    return active;
  } catch (error) {
    active = null;
    throw error;
  }
}
export async function recordSample() {
  if (!active || active.state !== "recording" || stopping) {
    return;
  }
  if (writing) {
    skipped++;
    return;
  }
  writing = true;
  const record = active;
  try {
    let obs: ReturnType<typeof freshObservation>;
    try {
      obs = freshObservation();
    } catch (error) {
      throw new TransientMiss(
        error instanceof Error ? error.message : "Observation unavailable"
      );
    }
    const currentFrames = frames();
    const sampledAt = Date.now();
    const sampledClock = { ...clock };
    if (obs.boot_id !== bootId)
      throw new Error("Recording stopped: motor service restarted");
    const stat = await statfs(record.path);
    if (stat.bavail * stat.bsize < 512 * 1024 * 1024) {
      throw new Error("Recording stopped: storage reserve reached");
    }
    const images: Record<string, unknown> = {};
    for (const name of ["workspace", "wrist"]) {
      const frame = currentFrames[name];
      if (
        !frame ||
        frame.age_ms > 500 ||
        frame.clock_domain !== obs.clock_domain
      ) {
        throw new TransientMiss(`Camera ${name} is stale or unavailable`);
      }
      const filename = `${name}-${frame.id.replaceAll(/[^a-zA-Z0-9-]/g, "_")}.jpg`;
      if (!known.has(frame.id)) {
        await writeFile(
          join(record.path, "images", filename),
          Buffer.from(frame.base64, "base64")
        );
        known.add(frame.id);
      }
      images[name] = {
        ...frame,
        base64: undefined,
        path: `images/${filename}`,
        state_skew_ms: (frame.monotonic_s - obs.monotonic_s) * 1000,
      };
    }
    await appendFile(
      `${record.path}/samples.jsonl`,
      `${JSON.stringify({
        index: record.frames,
        observation: obs,
        images,
        clock: sampledClock,
        time_ms: obs.monotonic_s * 1000,
        sample_time_ms: sampledAt,
      })}\n`
    );
    record.frames++;
    consecutiveMisses = 0;
    db.query("UPDATE recordings SET frames=? WHERE id=?").run(
      record.frames,
      record.id
    );
  } catch (error) {
    if (error instanceof TransientMiss) {
      skipped++;
      consecutiveMisses++;
      if (consecutiveMisses >= MISS_LIMIT) {
        markIncomplete(
          record,
          `Recording stopped: ${error.message} for ${consecutiveMisses} consecutive samples`
        );
      }
    } else {
      markIncomplete(
        record,
        error instanceof Error ? error.message : "Recording failed"
      );
    }
  } finally {
    writing = false;
  }
}
export function recordEvent(event: AppEvent): Promise<void> {
  const record = active;
  if (!record || stopping || record.state !== "recording")
    return Promise.resolve();
  if (pendingEvents >= 512) {
    markIncomplete(record, "Recording event queue overflowed");
    return Promise.resolve();
  }
  pendingEvents += 1;
  eventTail = eventTail
    .then(async () => {
      if (
        event.type === "shell.completed" &&
        typeof event.data["program_sha256"] === "string"
      ) {
        const hash = event.data["program_sha256"];
        if (/^[a-f0-9]{64}$/u.test(hash))
          await writeFile(
            `${record.path}/programs/${hash}.sh`,
            await readFile(`${config.dataDir}/programs/${hash}.sh`)
          );
      }
      await appendFile(
        `${record.path}/events.jsonl`,
        `${JSON.stringify(event)}\n`
      );
    })
    .catch((error: unknown) => {
      markIncomplete(
        record,
        error instanceof Error ? error.message : "Recording event write failed"
      );
    })
    .finally(() => {
      pendingEvents -= 1;
    });
  return eventTail;
}
export function stopRecording(): Promise<Recording> {
  if (stopPending) return stopPending;
  if (!active) throw new ApiError("No active recording");
  stopping = true;
  stopPending = finalizeRecording().finally(() => {
    stopPending = null;
  });
  return stopPending;
}
async function finalizeRecording() {
  if (!active) {
    throw new ApiError("No active recording");
  }
  stopping = true;
  while (writing) {
    await Bun.sleep(10);
  }
  await eventTail;
  const record = active;
  const manifest = JSON.parse(
    await readFile(`${record.path}/manifest.json`, "utf-8")
  );
  record.finished = Date.now();
  // One observation per successful poll is the real ceiling: the tailnet round
  // trip to the motor owner is about 160 ms, so the 10 Hz target cannot be met
  // and overlapping polls are backpressure rather than lost data. Judge the
  // recording on the rate it achieved, and report both.
  const seconds = Math.max(0.001, (record.finished - record.created) / 1000);
  const achieved = record.frames / seconds;
  record.state =
    record.state === "incomplete"
      ? "incomplete"
      : achieved >= MIN_FPS
        ? "captured"
        : "incomplete";
  record.error ??=
    achieved >= MIN_FPS
      ? null
      : `Recorded ${achieved.toFixed(1)} samples per second, below the ${MIN_FPS} floor (${skipped} missed)`;
  await writeFile(
    `${record.path}/manifest.json.tmp`,
    JSON.stringify(
      {
        ...manifest,
        state: record.state,
        frames: record.frames,
        finished: record.finished,
        sampling_fps_achieved: Number(achieved.toFixed(2)),
        missed_samples: skipped,
        error: record.error,
      },
      null,
      2
    )
  );
  await rename(
    `${record.path}/manifest.json.tmp`,
    `${record.path}/manifest.json`
  );
  db.query("UPDATE recordings SET state=?,finished=?,error=? WHERE id=?").run(
    record.state,
    record.finished,
    record.error,
    record.id
  );
  active = null;
  stopping = false;
  emit("recording.stopped", {
    id: record.id,
    state: record.state,
    frames: record.frames,
  });
  return record;
}
