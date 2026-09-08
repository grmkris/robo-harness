import { expect, test } from "bun:test";

import type { Frame } from "@robo/domain";
import { Effect } from "effect";
import { PNG } from "pngjs";

import {
  falInput,
  normalizeFal,
  runFalRequest,
  FAL_SEGMENT,
} from "./fal-perception";
const frame: Frame = {
  id: "frame-1",
  camera: "workspace",
  seq: 1,
  monotonic_s: 1,
  wall_time_ms: 1000,
  clock_domain: "boot",
  age_ms: 0,
  width: 2,
  height: 1,
  media_type: "image/jpeg",
  base64: "fixture",
};
const png = (width = 2) => {
  const image = new PNG({ width, height: 1 });
  image.data.fill(255);
  return `data:image/png;base64,${PNG.sync.write(image).toString("base64")}`;
};
const options = {
  kind: "segment" as const,
  frame,
  prompt: "white piece",
  requestId: "job",
  signal: new AbortController().signal,
};
test("SAM 3 maps masks to the original frame, including an empty detection", async () => {
  const result = await normalizeFal({
    ...options,
    raw: { masks: [{ url: png() }], scores: [0.9] },
  });
  expect(result.frame_id).toBe(frame.id);
  expect(result.units).toBe("pixels");
  expect(result).toMatchObject({
    masks: [{ area_pixels: 2, bounds_pixels: [0, 0, 2, 1], score: 0.9 }],
  });
  const empty = await normalizeFal({ ...options, raw: { masks: [] } });
  expect(empty).toMatchObject({ masks: [] });
  expect(PNG.sync.read(Buffer.from(empty.preview_png, "base64")).width).toBe(2);
  expect(falInput(frame, "segment", "white piece")).toMatchObject({
    apply_mask: false,
    max_masks: 3,
    prompt: "white piece",
  });
});
test("depth remains relative and carries the scale back to source pixels", async () => {
  const result = await normalizeFal({
    ...options,
    kind: "depth",
    raw: { image: { url: png(1) } },
  });
  expect(result.units).toBe("relative");
  expect(result).toMatchObject({
    preview_to_image: [
      [2, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  });
  expect(result).not.toHaveProperty("depth");
});
test("fal rejects mismatched masks, private media URLs, and malformed PNG data", async () => {
  for (const url of [
    png(1),
    "http://127.0.0.1/secret",
    "https://fal.media.evil.test/a.png",
    "data:image/png;base64,YmFk",
  ]) {
    const result = await normalizeFal({
      ...options,
      raw: { masks: [{ url }] },
    }).catch(() => null);
    expect(result).toBeNull();
  }
});
const job = {
  request_id: "job",
  status_url: "https://queue.fal.run/model/requests/job/status",
  response_url: "https://queue.fal.run/model/requests/job",
  cancel_url: "https://queue.fal.run/model/requests/job/cancel",
};
test("fal cancellation submits once and cancels the same queued job", async () => {
  const methods: string[] = [];
  let reservations = 0;
  await Effect.runPromise(
    runFalRequest({
      endpoint: FAL_SEGMENT,
      key: "fixture",
      body: {},
      pollMs: 1,
      onSubmit: () => {
        reservations += 1;
      },
      onRejected: () => {
        reservations -= 1;
      },
      fetcher: async (_url, init) => {
        methods.push(init?.method ?? "GET");
        return Response.json(
          init?.method === "POST" ? job : { status: "IN_QUEUE" }
        );
      },
    }).pipe(Effect.scoped, Effect.timeout(25))
  ).catch(() => {});
  expect(reservations).toBe(1);
  expect(methods.filter((x) => x === "POST")).toHaveLength(1);
  expect(methods.at(-1)).toBe("PUT");
});
test("a definite rejection refunds, while a lost acknowledgement retains its reservation", async () => {
  for (const status of [422, 500]) {
    let reservations = 0,
      submissions = 0;
    await Effect.runPromise(
      runFalRequest({
        endpoint: FAL_SEGMENT,
        key: "fixture",
        body: {},
        onSubmit: () => {
          reservations += 1;
        },
        onRejected: () => {
          reservations -= 1;
        },
        fetcher: async () => {
          submissions += 1;
          return new Response("rejected", { status });
        },
      }).pipe(Effect.scoped)
    ).catch(() => {});
    expect(submissions).toBe(1);
    expect(reservations).toBe(status === 422 ? 0 : 1);
  }
});
test("provider media downloads never receive the fal credential", async () => {
  let authorized = false;
  await normalizeFal({
    ...options,
    raw: { masks: [{ url: "https://v3.fal.media/files/mask.png" }] },
    fetcher: async (_url, init) => {
      authorized = new Headers(init?.headers).has("Authorization");
      return new Response(Buffer.from(png().split(",")[1]!, "base64"));
    },
  });
  expect(authorized).toBe(false);
});
