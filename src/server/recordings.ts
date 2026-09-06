import { createHash } from "node:crypto";
import {
  mkdir,
  writeFile,
  appendFile,
  statfs,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { AppEvent } from "../shared/contracts";
import { config } from "./config";
import { freshObservation, currentFrames, clock, ApiError } from "./robot";
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
const known = new Set<string>();
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
  const obs = freshObservation();
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
          version: 1,
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
    active.state = "recording";
    db.query(
      "INSERT INTO recordings(id,label,state,path,created) VALUES(?,?,?,?,?)"
    ).run(id, label, "recording", path, created);
    known.clear();
    skipped = 0;
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
    const obs = freshObservation();
    const stat = await statfs(record.path);
    if (stat.bavail * stat.bsize < 512 * 1024 * 1024) {
      throw new Error("Recording stopped: storage reserve reached");
    }
    const images: Record<string, unknown> = {};
    for (const name of ["workspace", "wrist"]) {
      const frame = currentFrames[name];
      if (!frame || frame.age_ms > 500) {
        throw new Error("Recording stopped: required camera unavailable");
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
      };
    }
    await appendFile(
      `${record.path}/samples.jsonl`,
      `${JSON.stringify({
        index: record.frames,
        observation: obs,
        images,
        clock,
        sample_time_ms: Date.now(),
      })}\n`
    );
    record.frames++;
    db.query("UPDATE recordings SET frames=? WHERE id=?").run(
      record.frames,
      record.id
    );
  } catch (error) {
    record.state = "incomplete";
    record.error = error instanceof Error ? error.message : "Recording failed";
    db.query("UPDATE recordings SET state='incomplete',error=? WHERE id=?").run(
      record.error,
      record.id
    );
    emit("recording.error", { id: record.id, message: record.error });
  } finally {
    writing = false;
  }
}
export async function recordEvent(event: AppEvent) {
  // Capture the recording before awaiting: stopRecording or a new start may
  // change `active` while the program file is read, and the event must land in
  // the recording that was live when it happened.
  const record = active;
  if (!record) {
    return;
  }
  if (
    event.type === "shell.completed" &&
    typeof event.data["program_sha256"] === "string"
  ) {
    const hash = event.data["program_sha256"];
    if (/^[a-f0-9]{64}$/.test(hash)) {
      await writeFile(
        `${record.path}/programs/${hash}.sh`,
        await readFile(`${config.dataDir}/programs/${hash}.sh`)
      );
    }
  }
  await appendFile(`${record.path}/events.jsonl`, `${JSON.stringify(event)}\n`);
}
export async function stopRecording() {
  if (!active) {
    throw new ApiError("No active recording");
  }
  stopping = true;
  while (writing) {
    await Bun.sleep(10);
  }
  const record = active;
  const manifest = JSON.parse(
    await readFile(`${record.path}/manifest.json`, "utf-8")
  );
  record.finished = Date.now();
  record.state =
    record.state === "incomplete"
      ? "incomplete"
      : skipped
        ? "incomplete"
        : "captured";
  record.error ??= skipped ? `${skipped} sample deadlines were missed` : null;
  await writeFile(
    `${record.path}/manifest.json`,
    JSON.stringify(
      {
        ...manifest,
        state: record.state,
        frames: record.frames,
        finished: record.finished,
        missed_samples: skipped,
        error: record.error,
      },
      null,
      2
    )
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
