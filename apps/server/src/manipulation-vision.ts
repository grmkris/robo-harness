import type { Frame } from "@robo/domain";
import jpeg from "jpeg-js";

import { ToolFailure } from "./tool-errors";

export interface Crop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Crop uses source pixels. Its own calibration records the inverse pixel mapping. */
export const cropFrame = (frame: Frame, crop?: Crop): Frame => {
  if (!crop) return frame;
  if (
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width < 1 ||
    crop.height < 1 ||
    crop.x + crop.width > frame.width ||
    crop.y + crop.height > frame.height
  ) {
    throw new ToolFailure({
      code: "INVALID_INPUT",
      detail: "Crop must be inside the source image, in pixels.",
    });
  }
  const decoded = jpeg.decode(Buffer.from(frame.base64, "base64"), {
    useTArray: true,
    maxMemoryUsageInMB: 64,
  });
  const scale = Math.min(
    4,
    Math.max(
      1,
      Math.floor(Math.min(frame.width / crop.width, frame.height / crop.height))
    )
  );
  const height = crop.height * scale;
  const width = crop.width * scale;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source =
        ((crop.y + Math.floor(y / scale)) * decoded.width +
          crop.x +
          Math.floor(x / scale)) *
        4;
      const destination = (y * width + x) * 4;
      data.set(decoded.data.subarray(source, source + 4), destination);
    }
  }
  return {
    ...frame,
    id: frame.id + ":crop",
    width,
    height,
    media_type: "image/jpeg",
    base64: jpeg.encode({ data, width, height }, 85).data.toString("base64"),
    calibration: {
      source_frame_id: frame.id,
      source_width: frame.width,
      source_height: frame.height,
      source_crop: crop,
      crop_to_source: [
        [1 / scale, 0, crop.x],
        [0, 1 / scale, crop.y],
        [0, 0, 1],
      ],
      note: "Derived crop. Use source pixels for workspace homography.",
    },
  };
};

export const requireFreshFrame = (frame: Frame): Frame => {
  if (frame.age_ms > 400)
    throw new ToolFailure({
      code: "TRANSIENT_CAMERA",
      detail:
        frame.camera +
        " camera is stale. Wait and look again; do not move from this frame.",
    });
  return frame;
};
