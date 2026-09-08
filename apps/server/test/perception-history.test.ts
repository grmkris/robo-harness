import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";

import { startHarness } from "./harness";

test("perception history preserves exact source, failures, pagination and legacy results", async () => {
  const h = await startHarness();
  try {
    await h.request("/api/budget", { limit: 1 });
    const made = await h.call("perceive", {
      camera: "workspace",
      kind: "segment",
      prompt: "white object",
    });
    expect(made.status).toBe(200);
    const id = made.data.id;
    const page = await (await h.request("/api/perception")).json();
    expect(page.items[0].id).toBe(id);
    expect(page.items[0].prompt).toBe("white object");
    const detail = await (
      await h.request(`/api/perception/${id}/detail`)
    ).json();
    expect(detail.result.frame_id).toBe(page.items[0].frame_id);
    const image = Buffer.from(
      await (await h.request(page.items[0].source_url)).arrayBuffer()
    );
    expect(
      image.equals(await readFile(`${h.dataDir}/perception/${id}/source.jpg`))
    ).toBe(true);
    expect(
      (await h.request(`/api/perception/${id}/source`, undefined, "invalid"))
        .status
    ).toBe(401);
    const failure = await h.call("perceive", {
      camera: "wrist",
      kind: "segment",
      prompt: "reject",
    });
    expect(failure.status).toBe(502);
    const failed = await (await h.request("/api/perception")).json();
    expect(failed.items[0].state).toBe("failed");
    expect(failed.items[0].prompt).toBe("reject");
    expect(failed.items[0].source_url).toBeTruthy();
    await rm(`${h.dataDir}/perception/${id}/source.jpg`);
    const legacy = await (
      await h.request(`/api/perception/${id}/detail`)
    ).json();
    expect(legacy.check.source_url).toBeNull();
    expect(legacy.check.preview_url).toBeTruthy();
    const db = new Database(`${h.dataDir}/harness.sqlite`);
    for (let i = 0; i < 26; i++)
      db.run(
        "INSERT INTO perception(id,state,source,created) SELECT ?,state,source,created FROM perception WHERE id=?",
        [crypto.randomUUID(), id]
      );
    db.close();
    const first = await (await h.request("/api/perception")).json();
    const second = await (
      await h.request(`/api/perception?before=${first.next}`)
    ).json();
    expect(first.items.length).toBe(25);
    expect(second.items.length).toBe(3);
    expect(
      second.items.some((row: { id: string }) =>
        first.items.some((other: { id: string }) => row.id === other.id)
      )
    ).toBe(false);
    expect((await h.request("/api/perception?before=bad")).status).toBe(400);
  } finally {
    await h.close();
  }
}, 20_000);

test("late perception result stays associated with its original recording", async () => {
  const release = Promise.withResolvers<boolean>();
  const submitted = Promise.withResolvers<boolean>();
  const worker = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const input = (await req.json()) as {
        kind: string;
        frame: { id: string; width: number; height: number };
      };
      submitted.resolve(true);
      await release.promise;
      return Response.json({
        kind: input.kind,
        model: "delayed-fixture",
        model_version: "1",
        frame_id: input.frame.id,
        width: input.frame.width,
        height: input.frame.height,
        preview_png: "",
        masks: [],
      });
    },
  });
  const h = await startHarness({
    env: { ROBO_PERCEPTION_URL: `http://127.0.0.1:${worker.port}` },
  });
  try {
    await h.request("/api/budget", { limit: 1 });
    let recording = await h.call("recording_start", { label: "Late result" });
    if (recording.status === 503)
      await h.until(async () => {
        recording = await h.call("recording_start", { label: "Late result" });
        return recording.status === 200;
      });
    await h.until(async () => ((await h.status()).recording?.frames ?? 0) >= 4);
    const pending = h.call("perceive", {
      camera: "workspace",
      kind: "segment",
      prompt: "late object",
    });
    await submitted.promise;
    await h.call("recording_stop");
    release.resolve(true);
    const result = await pending;
    expect(result.status).toBe(200);
    const page = await (
      await h.request(`/api/perception?recording_id=${recording.data.id}`)
    ).json();
    expect(page.items.length).toBe(1);
    expect(page.items[0].id).toBe(result.data.id);
  } finally {
    release.resolve(true);
    await h.close();
    await worker.stop(true);
  }
}, 20_000);
