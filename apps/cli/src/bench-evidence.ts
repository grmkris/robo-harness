import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Frame, Observation } from "@robo/domain";
import { Schema } from "effect";

const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** Evidence is append-only. An existing artifact is never silently replaced. */
const saveFrame = (directory: string, frame: Frame) => {
  if (frame.camera !== "workspace" && frame.camera !== "wrist") {
    throw new Error("Evidence camera must be workspace or wrist");
  }
  if (frame.media_type !== "image/jpeg") {
    throw new Error("Expected original JPEG camera evidence");
  }
  const { base64, ...metadata } = frame;
  const bytes = Buffer.from(base64, "base64");
  const image = `${frame.camera}.jpg`;
  const record = { ...metadata, image, sha256: hash(bytes) };
  writeFileSync(join(directory, image), bytes, { flag: "wx", mode: 0o600 });
  writeFileSync(
    join(directory, `${frame.camera}.json`),
    JSON.stringify(record, null, 2) + "\n",
    {
      flag: "wx",
      mode: 0o600,
    }
  );
  return record;
};

interface CaptureOptions {
  readonly directory: string;
  readonly baseUrl: string;
  readonly token?: string;
  readonly signal?: AbortSignal;
}

/** Read-only coordinator capture. No motor/provider credentials or motion API. */
export const captureEvidence = async (options: CaptureOptions) => {
  options.signal?.throwIfAborted();
  mkdirSync(dirname(options.directory), { recursive: true, mode: 0o700 });
  // Reserve before network I/O. Never append a new run to another run's evidence.
  mkdirSync(options.directory, { mode: 0o700 });
  const capturedAt = new Date().toISOString();
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  let observationRetries = 0;
  const request = async (
    name: "observe" | "capture",
    body: { camera?: string }
  ): Promise<unknown> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const signals = [AbortSignal.timeout(5000)];
      if (options.signal) signals.push(options.signal);
      const response = await fetch(`${options.baseUrl}/api/tool/${name}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
      // Cached observations can briefly age beyond 250 ms on this tailnet hop.
      // Retry only this read-only transient. Never relax the freshness limit.
      if (name === "observe" && response.status === 503 && attempt < 4) {
        await response.body?.cancel();
        observationRetries += 1;
        await Bun.sleep(100);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Evidence ${name}: HTTP ${response.status}`);
      }
      return response.json() as Promise<unknown>;
    }
    throw new Error("Observation retry bound reached");
  };
  const readObservation = async () =>
    Schema.decodeUnknownSync(Observation)(await request("observe", {}));
  try {
    const before = await readObservation();
    const frames = await Promise.all(
      ["workspace", "wrist"].map(async (camera) => {
        const started = performance.now();
        const frame = Schema.decodeUnknownSync(Frame)(
          await request("capture", { camera })
        );
        if (frame.camera !== camera)
          throw new Error(`Capture returned the wrong camera for ${camera}`);
        if (
          frame.age_ms < 0 ||
          frame.age_ms + performance.now() - started > 500
        ) {
          throw new Error(`${camera} evidence is stale`);
        }
        return frame;
      })
    );
    const after = await readObservation();
    if (
      before.boot_id !== after.boot_id ||
      before.clock_domain !== after.clock_domain ||
      frames.some((frame) => frame.clock_domain !== before.clock_domain)
    ) {
      throw new Error("Capture crossed a robot clock or boot change");
    }
    const saved = frames.map((frame) => saveFrame(options.directory, frame));
    const observations = JSON.stringify({ before, after }, null, 2) + "\n";
    writeFileSync(join(options.directory, "observations.json"), observations, {
      flag: "wx",
      mode: 0o600,
    });
    const manifest = {
      captured_at: capturedAt,
      observation_retries: observationRetries,
      status: "captured",
      frames: saved,
      observations: { path: "observations.json", sha256: hash(observations) },
      note: "Read-only evidence capture; not a benchmark trial or a success judgement.",
    };
    writeFileSync(
      join(options.directory, "capture.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 }
    );
    return manifest;
  } catch (error) {
    writeFileSync(
      join(options.directory, "capture-failed.json"),
      JSON.stringify(
        {
          captured_at: capturedAt,
          observation_retries: observationRetries,
          status: "incomplete",
          error: error instanceof Error ? error.message : "Capture failed",
        },
        null,
        2
      ) + "\n",
      { flag: "wx", mode: 0o600 }
    );
    throw error;
  }
};
