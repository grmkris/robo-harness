import { expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";

import { startHarness, type Harness } from "./harness";
const beginRecording = async (h: Harness, label: string) => {
  let result = await h.call("recording_start", { label });
  if (result.status === 503)
    await h.until(async () => {
      result = await h.call("recording_start", { label });
      return result.status === 200;
    });
  expect(result.status).toBe(200);
  return result;
};

test("recording stop drains writes; archived frames and MP4 are available through authenticated APIs", async () => {
  const h = await startHarness();
  try {
    const started = await beginRecording(h, "Export fixture");
    expect(started.status).toBe(200);
    await h.until(async () => ((await h.status()).recording?.frames ?? 0) >= 8);
    const stopped = await Promise.all([
      h.call("recording_stop"),
      h.call("recording_stop"),
    ]);
    expect(stopped[0]?.data.id).toBe(started.data.id);
    expect(stopped[1]?.data.id).toBe(started.data.id);
    const samples = (
      await readFile(`${started.data.path}/samples.jsonl`, "utf-8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(samples[0].time_ms).toBe(samples[0].observation.monotonic_s * 1000);
    const detail = await h.call("recording_inspect", { id: started.data.id });
    expect(detail.status).toBe(200);
    expect(detail.data.frames).toBe(samples.length);
    const frame = await h.call("recording_frame", {
      id: started.data.id,
      camera: "workspace",
      time_s: 0,
    });
    expect(frame.data.base64.length).toBeGreaterThan(100);
    const exported = await h.call("recording_export", {
      id: started.data.id,
      kind: "mp4",
      task: "Open the mock gripper",
    });
    expect(exported.data.error).toBeNull();
    expect(exported.data.state).toBe("completed");
    const download = await h.request(exported.data.url);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("video/mp4");
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.subarray(4, 8).toString()).toBe("ftyp");
    expect(
      (await h.request(exported.data.url, undefined, "invalid")).status
    ).toBe(401);
    expect(
      (await h.call("recording_inspect", { id: "../../secret" })).status
    ).toBe(400);
  } finally {
    await h.close();
  }
}, 30_000);

test("a failed event write makes the recording incomplete before Stop returns", async () => {
  const h = await startHarness();
  try {
    const start = await beginRecording(h, "Writer failure");
    expect(start.status).toBe(200);
    await h.until(async () => ((await h.status()).recording?.frames ?? 0) >= 2);
    // A directory in place of events.jsonl forces a real append failure.
    const { rename } = await import("node:fs/promises");
    await rename(
      `${start.data.path}/events.jsonl`,
      `${start.data.path}/saved-events.jsonl`
    );
    await mkdir(`${start.data.path}/events.jsonl`);
    await h.request("/api/budget", { limit: 0.1 });
    const stopped = await h.call("recording_stop");
    expect(stopped.data.state).toBe("incomplete");
    expect(stopped.data.error).toBeTruthy();
  } finally {
    await h.close();
  }
}, 15_000);
