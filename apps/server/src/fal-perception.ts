import type { Frame } from "@robo/domain";
import { Effect, Schema } from "effect";
import { PNG } from "pngjs";

export const FAL_SEGMENT = "fal-ai/sam-3/image";
export const FAL_DEPTH = "fal-ai/image-preprocessors/depth-anything/v2";
const MAX_BYTES = 8 * 1024 * 1024;
const Pixels = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 4096 })
);
const ImageFile = Schema.Struct({
  url: Schema.String,
  width: Schema.optionalKey(Pixels),
  height: Schema.optionalKey(Pixels),
});
const Job = Schema.Struct({
  request_id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/u)),
  status_url: Schema.String,
  response_url: Schema.String,
  cancel_url: Schema.String,
});
const JobStatus = Schema.Struct({
  status: Schema.Literals(["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]),
  error: Schema.optionalKey(Schema.Unknown),
});
const Segmentation = Schema.Struct({
  masks: Schema.Array(ImageFile).check(Schema.isMaxLength(3)),
  scores: Schema.optionalKey(Schema.Array(Schema.Finite)),
});
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const rejected = new Set([400, 401, 403, 404, 405, 413, 415, 422, 429]);
const request = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error });

const readBytes = async (
  response: Response,
  maximum: number
): Promise<Buffer> => {
  if (!response.ok || !response.body)
    throw new Error(`Provider HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body.cancel();
    throw new Error("Provider response exceeds size limit");
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum)
        throw new Error("Provider response exceeds size limit");
      parts.push(part.value);
    }
    return Buffer.concat(parts);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};
const json = async (response: Response): Promise<unknown> =>
  JSON.parse((await readBytes(response, MAX_BYTES * 4)).toString("utf-8"));
const jobUrl = (value: string, id: string): string => {
  const url = new URL(value);
  if (
    url.origin !== "https://queue.fal.run" ||
    url.username ||
    url.password ||
    !url.pathname.includes(`/requests/${id}`)
  )
    throw new Error("Untrusted fal job URL");
  return value;
};

/** One submission, bounded polling, and cancellation owned by the Effect scope. */
export const runFalRequest = Effect.fn("Perception.falQueue")(
  function* falQueue(options: {
    endpoint: string;
    key: string;
    body: unknown;
    onSubmit: () => void;
    onRejected: () => void;
    fetcher?: Fetch;
    pollMs?: number;
  }) {
    if (!/^[a-zA-Z0-9_/-]+$/u.test(options.endpoint))
      throw new Error("Invalid fal endpoint");
    const fetcher = options.fetcher ?? fetch;
    const headers = {
      Authorization: `Key ${options.key}`,
      "Content-Type": "application/json",
    };
    const rawJob = yield* request(async (signal) => {
      options.onSubmit();
      const response = await fetcher(
        `https://queue.fal.run/${options.endpoint}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(options.body),
          signal,
          redirect: "error",
        }
      );
      if (rejected.has(response.status)) options.onRejected();
      return json(response);
    });
    const job = Schema.decodeUnknownSync(Job)(rawJob);
    const statusUrl = jobUrl(job.status_url, job.request_id);
    const responseUrl = jobUrl(job.response_url, job.request_id);
    const cancelUrl = jobUrl(job.cancel_url, job.request_id);
    let completed = false;
    yield* Effect.acquireRelease(Effect.void, () =>
      Effect.promise(async () => {
        if (!completed)
          await fetcher(cancelUrl, {
            method: "PUT",
            headers,
            signal: AbortSignal.timeout(5000),
            redirect: "error",
          }).catch(() => {});
      })
    );
    for (;;) {
      const state = Schema.decodeUnknownSync(JobStatus)(
        yield* request(async (signal) =>
          json(await fetcher(statusUrl, { headers, signal, redirect: "error" }))
        )
      );
      if (state.error) throw new Error("fal inference failed");
      if (state.status === "COMPLETED") break;
      yield* Effect.sleep(options.pollMs ?? 500);
    }
    const result = yield* request(async (signal) =>
      json(await fetcher(responseUrl, { headers, signal, redirect: "error" }))
    );
    completed = true;
    return { result, request_id: job.request_id };
  }
);

const decodePng = async (bytes: Buffer): Promise<PNG> => {
  // Check dimensions before the codec allocates its pixel buffer.
  if (
    bytes.length < 33 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  )
    throw new Error("fal returned a non-PNG image");
  const width = Schema.decodeUnknownSync(Pixels)(bytes.readUInt32BE(16));
  const height = Schema.decodeUnknownSync(Pixels)(bytes.readUInt32BE(20));
  if (width * height > 4_194_304)
    throw new Error("fal image has too many pixels");
  const done = Promise.withResolvers<PNG>();
  new PNG().parse(bytes, (error, image) => {
    if (error) done.reject(new Error("Invalid PNG image"));
    else done.resolve(image);
  });
  return done.promise;
};
const encodePng = (png: PNG): Promise<Buffer> => {
  const done = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  png
    .pack()
    .on("data", (chunk: Buffer) => chunks.push(chunk))
    .on("end", () => done.resolve(Buffer.concat(chunks)))
    .on("error", done.reject);
  return done.promise;
};
const imageBytes = async (
  file: typeof ImageFile.Type,
  signal: AbortSignal,
  fetcher: Fetch
): Promise<Buffer> => {
  if (file.url.startsWith("data:image/png;base64,")) {
    const value = file.url.slice("data:image/png;base64,".length);
    if (
      value.length > MAX_BYTES * 1.4 ||
      !/^[a-zA-Z0-9+/]*={0,2}$/u.test(value)
    )
      throw new Error("Invalid inline PNG");
    return Buffer.from(value, "base64");
  }
  const url = new URL(file.url);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !(url.hostname === "fal.media" || url.hostname.endsWith(".fal.media"))
  )
    throw new Error("Untrusted fal image URL");
  return readBytes(
    await fetcher(url.href, { signal, redirect: "error" }),
    MAX_BYTES
  );
};
export const falInput = (
  frame: Frame,
  kind: "segment" | "depth",
  prompt: string
) => ({
  image_url: `data:${frame.media_type};base64,${frame.base64}`,
  ...(kind === "segment"
    ? {
        prompt,
        apply_mask: false,
        output_format: "png",
        sync_mode: true,
        return_multiple_masks: true,
        max_masks: 3,
        include_scores: true,
      }
    : {}),
});

export const normalizeFal = async (options: {
  kind: "segment" | "depth";
  raw: unknown;
  frame: Frame;
  prompt: string;
  requestId: string;
  signal: AbortSignal;
  fetcher?: Fetch;
}) => {
  const { frame, kind, prompt, requestId, signal } = options;
  const fetcher = options.fetcher ?? fetch;
  const source = {
    kind,
    frame_id: frame.id,
    width: frame.width,
    height: frame.height,
    provider_request_id: requestId,
    model_version: "hosted-unpinned",
  };
  if (kind === "depth") {
    const { image } = Schema.decodeUnknownSync(
      Schema.Struct({ image: ImageFile })
    )(options.raw);
    const bytes = await imageBytes(image, signal, fetcher);
    const decoded = await decodePng(bytes);
    return {
      ...source,
      model: "Depth Anything V2 (fal)",
      units: "relative",
      preview_png: bytes.toString("base64"),
      preview_width: decoded.width,
      preview_height: decoded.height,
      preview_to_image: [
        [frame.width / decoded.width, 0, 0],
        [0, frame.height / decoded.height, 0],
        [0, 0, 1],
      ],
      note: "Relative-depth visualization only. Pixel values are not meters and are not a calibrated grasp target.",
    };
  }
  const result = Schema.decodeUnknownSync(Segmentation)(options.raw);
  const masks = [];
  const preview = new PNG({ width: frame.width, height: frame.height });
  preview.data.fill(0);
  for (const [index, file] of result.masks.entries()) {
    signal.throwIfAborted();
    const bytes = await imageBytes(file, signal, fetcher);
    const decoded = await decodePng(bytes);
    if (decoded.width !== frame.width || decoded.height !== frame.height)
      throw new Error("fal mask geometry does not match the source frame");
    let area = 0;
    let left = frame.width;
    let top = frame.height;
    let right = -1;
    let bottom = -1;
    for (let pixel = 0; pixel < frame.width * frame.height; pixel += 1) {
      const offset = pixel * 4;
      if (
        (decoded.data[offset] ?? 0) > 127 &&
        (decoded.data[offset + 3] ?? 0) > 0
      ) {
        const x = pixel % frame.width,
          y = Math.floor(pixel / frame.width);
        area += 1;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
        preview.data[offset] = 120;
        preview.data[offset + 1] = 210;
        preview.data[offset + 2] = 160;
        preview.data[offset + 3] = 255;
      }
    }
    const score = result.scores?.[index];
    masks.push({
      png: bytes.toString("base64"),
      label: prompt,
      ...(score === undefined ? {} : { score }),
      area_pixels: area,
      bounds_pixels: area ? [left, top, right + 1, bottom + 1] : null,
    });
  }
  return {
    ...source,
    model: "SAM 3 (fal)",
    units: "pixels",
    masks,
    preview_png: (await encodePng(preview)).toString("base64"),
    note: masks.length
      ? "Image-space masks only; grasp coordinates require calibration."
      : "No matching object was detected.",
  };
};
