import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, mkdir, writeFile, rename } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  AppEvent,
  Frame,
  Observation,
  RecordingArtifact,
  type RecordingDetail,
  type RecordingExport,
} from "@robo/domain";
import { Effect, Schema } from "effect";

import { config } from "./config";
import { ApiError } from "./robot";
import { db, emit } from "./store";

const Sample = Schema.Struct({
  index: Schema.Int,
  observation: Observation,
  images: Schema.Record(
    Schema.String,
    Schema.Struct({
      ...Frame.fields,
      base64: Schema.optionalKey(Schema.String),
      path: Schema.String,
    })
  ),
  time_ms: Schema.optionalKey(Schema.Finite),
  sample_time_ms: Schema.Finite,
});
const Manifest = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  state: Schema.String,
  backend: Schema.String,
  created: Schema.Finite,
  sampling_fps: Schema.Finite,
});
const RecordPath = Schema.Struct({ path: Schema.String });
const recordPath = (id: string): string => {
  const row = db.query("SELECT path FROM recordings WHERE id=?").get(id);
  if (!row) throw new ApiError("Recording not found", 404);
  return Schema.decodeUnknownSync(RecordPath)(row).path;
};
const sampleTime = (row: typeof Sample.Type) =>
  row.time_ms ?? row.sample_time_ms;
const readRecording = async (id: string) => {
  const path = recordPath(id);
  const manifest = Schema.decodeUnknownSync(Manifest)(
    JSON.parse(await readFile(join(path, "manifest.json"), "utf-8"))
  );
  const lines = (await readFile(join(path, "samples.jsonl"), "utf-8")).trim();
  const samples = lines
    ? lines
        .split("\n")
        .map((line) => Schema.decodeUnknownSync(Sample)(JSON.parse(line)))
    : [];
  return { path, manifest, samples };
};
export const inspectRecording = async (
  id: string
): Promise<RecordingDetail> => {
  const { path, manifest, samples } = await readRecording(id);
  const first = samples[0];
  const last = samples.at(-1);
  const duration =
    first && last ? (sampleTime(last) - sampleTime(first)) / 1000 : 0;
  const lines = await readFile(join(path, "events.jsonl"), "utf-8").catch(
    () => ""
  );
  const bookmarks = lines.trim()
    ? lines
        .trim()
        .split("\n")
        .map((line) => Schema.decodeUnknownSync(AppEvent)(JSON.parse(line)))
        .filter(
          (event) =>
            (event.type === "chat.motion" &&
              event.data["phase"] === "finished") ||
            event.type === "chat.steer" ||
            event.type === "chat.message" ||
            event.type === "control.stopped" ||
            event.type === "decision.stage_reached" ||
            event.type === "decision.task_failed" ||
            event.type === "decision.finished" ||
            event.type.endsWith(".error")
        )
        .slice(-200)
        .map((event) => ({
          time_s: Math.max(
            0,
            Math.min(
              duration,
              (event.time - (first?.sample_time_ms ?? manifest.created)) / 1000
            )
          ),
          type: event.type,
          text: String(
            event.data["text"] ??
              event.data["message"] ??
              event.data["phase"] ??
              event.data["end_reason"] ??
              event.type
          ).slice(0, 500),
        }))
    : [];
  const exports = [];
  for (const name of await readdir(join(path, "exports")).catch(
    () => [] as string[]
  )) {
    if (!/^[a-f0-9-]{36}$/u.test(name)) continue;
    const artifact = await readFile(
      join(path, "exports", name, "export.json"),
      "utf-8"
    ).catch(() => null);
    if (artifact)
      exports.push(
        Schema.decodeUnknownSync(RecordingArtifact)(JSON.parse(artifact))
      );
  }
  const intervals: { start_s: number; end_s: number }[] = [];
  let beginning: typeof Sample.Type | undefined;
  let previous: typeof Sample.Type | undefined;
  let maximumSkew = 0;
  const finish = () => {
    if (
      beginning &&
      previous &&
      first &&
      sampleTime(previous) - sampleTime(beginning) >=
        1000 / manifest.sampling_fps - 0.001
    )
      intervals.push({
        start_s: (sampleTime(beginning) - sampleTime(first)) / 1000,
        end_s: (sampleTime(previous) - sampleTime(first)) / 1000,
      });
    beginning = undefined;
  };
  for (const sample of samples) {
    const obs = sample.observation;
    let validImages = true;
    for (const camera of ["workspace", "wrist"]) {
      const image = sample.images[camera];
      if (!image || image.clock_domain !== obs.clock_domain) {
        validImages = false;
        continue;
      }
      const skew = Math.abs(image.monotonic_s - obs.monotonic_s) * 1000;
      maximumSkew = Math.max(maximumSkew, skew);
      if (skew > 150) validImages = false;
    }
    const valid =
      manifest.state !== "incomplete" &&
      !obs.fault &&
      obs.clock_domain === first?.observation.clock_domain &&
      validImages;
    if (
      !valid ||
      (previous &&
        (sampleTime(sample) - sampleTime(previous) > 250 ||
          sampleTime(sample) <= sampleTime(previous)))
    )
      finish();
    if (valid) beginning ??= sample;
    previous = sample;
  }
  finish();
  return {
    id,
    label: manifest.label,
    state: manifest.state,
    backend: manifest.backend,
    duration_s: Math.max(0, duration),
    frames: samples.length,
    sampling_fps: manifest.sampling_fps,
    bookmarks,
    exports,
    quality: { max_camera_skew_ms: maximumSkew, training_intervals: intervals },
  };
};
export const recordingFrame = async (
  id: string,
  camera: string,
  time: number
): Promise<Frame> => {
  const { path, samples } = await readRecording(id);
  const first = samples[0];
  if (!first) throw new ApiError("Recording has no frames", 404);
  const target = sampleTime(first) + time * 1000;
  let selected = first;
  for (const sample of samples) {
    if (
      Math.abs(sampleTime(sample) - target) <
      Math.abs(sampleTime(selected) - target)
    )
      selected = sample;
  }
  const frame = selected.images[camera];
  if (!frame) throw new ApiError("Recorded camera unavailable", 404);
  const file = resolve(path, frame.path);
  if (!file.startsWith(resolve(path, "images") + sep))
    throw new ApiError("Invalid recorded image path", 400);
  return {
    ...frame,
    age_ms: Math.max(0, Date.now() - frame.wall_time_ms),
    base64: (await readFile(file)).toString("base64"),
  };
};
const active = new Map<
  string,
  { controller: AbortController; done: Promise<RecordingArtifact> }
>();
const runExporter = Effect.fn("Recording.export")(function* runExporter(
  source: string,
  destination: string,
  input: RecordingExport
) {
  const python =
    process.env["ROBO_EXPORT_PYTHON"] ??
    (existsSync(`${config.root}/var/export-venv/bin/python`)
      ? `${config.root}/var/export-venv/bin/python`
      : `${config.root}/.venv/bin/python`);
  const child = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const proc = spawn(
        python,
        ["-m", "robo_harness.recording_export", source, destination],
        {
          detached: true,
          stdio: ["pipe", "ignore", "pipe"],
          env: {
            PATH: process.env["PATH"],
            PYTHONPATH: `${config.root}/python`,
            HF_HUB_OFFLINE: "1",
            HF_HUB_DISABLE_TELEMETRY: "1",
            OMP_NUM_THREADS: "2",
          },
        }
      );
      const done = Promise.withResolvers<number | null>();
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf-8")).slice(-4000);
      });
      proc.on("error", () => done.resolve(-1));
      proc.on("close", done.resolve);
      proc.stdin.on("error", () => {});
      proc.stdin.end(JSON.stringify(input));
      return { proc, done: done.promise, error: () => stderr };
    }),
    (child) =>
      Effect.promise(async () => {
        if (child.proc.pid && child.proc.exitCode === null) {
          try {
            process.kill(-child.proc.pid, "SIGKILL");
          } catch {
            /* Process already exited. */
          }
        }
        await child.done;
      })
  );
  const code = yield* Effect.promise(() => child.done);
  if (code !== 0)
    throw new Error(child.error() || "Export process could not start");
});
export const exportRecording = (
  input: RecordingExport,
  signal?: AbortSignal
): Promise<RecordingArtifact> => {
  if (active.size >= 1)
    throw new ApiError("Another recording export is running", 409);
  const source = recordPath(input.id);
  const id = crypto.randomUUID();
  const destination = join(source, "exports", id);
  const controller = new AbortController();
  let artifact: RecordingArtifact = {
    id,
    kind: input.kind,
    state: "running",
    task: input.task,
    start_s: input.start_s,
    ...(input.end_s === undefined ? {} : { end_s: input.end_s }),
    outcome: input.outcome,
    intervention: input.intervention,
    url: null,
    error: null,
  };
  const save = async () => {
    await writeFile(
      join(destination, "export.json.tmp"),
      JSON.stringify(artifact)
    );
    await rename(
      join(destination, "export.json.tmp"),
      join(destination, "export.json")
    );
  };
  const done = (async () => {
    await mkdir(destination, { recursive: true });
    await save();
    emit("recording.export_started", {
      id,
      recording_id: input.id,
      kind: input.kind,
    });
    try {
      await Effect.runPromise(
        runExporter(source, destination, input).pipe(
          Effect.scoped,
          Effect.timeout(120_000)
        ),
        {
          signal: signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal,
        }
      );
      artifact = {
        ...artifact,
        state: "completed",
        url: `/api/recordings/${input.id}/exports/${id}/${input.kind === "mp4" ? "clip.mp4" : "dataset.zip"}`,
      };
    } catch (error) {
      artifact = {
        ...artifact,
        state: "failed",
        error: (error instanceof Error
          ? error.message
          : "Recording export failed"
        ).slice(-1000),
      };
    }
    await save();
    emit("recording.export_finished", {
      id,
      recording_id: input.id,
      state: artifact.state,
      error: artifact.error,
    });
    return artifact;
  })().finally(() => {
    active.delete(id);
  });
  active.set(id, { controller, done });
  return done;
};
export const closeExports = async () => {
  const exports = [...active.values()];
  for (const job of exports) job.controller.abort();
  await Promise.allSettled(exports.map((job) => job.done));
};
export const recordingDownload = (
  id: string,
  exportId: string,
  filename: string
) => Bun.file(join(recordPath(id), "exports", exportId, filename));
