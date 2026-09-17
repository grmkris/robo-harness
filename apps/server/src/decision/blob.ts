import type { Frame } from "@robo/domain";
import jpeg from "jpeg-js";

import type { Detection } from "./state";

export interface BlobOptions {
  /** A pixel counts as the piece when its brightest channel reaches this. The
   *  wrist camera has a strong blue cast (the white piece reads ~50/160/200). */
  readonly minBrightness: number;
  /** Sample every Nth pixel in each direction. */
  readonly stride: number;
  /** Minimum sampled pixels for a detection. */
  readonly minPixels: number;
  /** Bright regions spanning at least this fraction of the frame width or height are background. */
  readonly maxSpan: number;
  /** Bright regions covering at least this fraction of the frame are background. */
  readonly maxArea: number;
}

const defaults: BlobOptions = {
  minBrightness: 130,
  stride: 4,
  minPixels: 12,
  maxSpan: 0.8,
  maxArea: 0.12,
};

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * White object on the black mat in one camera frame. Coordinates are image
 * offsets from the frame centre in [-1, 1] (+x right, +y down); they are not
 * robot coordinates and their relation to joint motion is uncalibrated.
 */
export const whiteBlob = (
  frame: Frame,
  options: Partial<BlobOptions> = {}
): Detection => {
  const settings = { ...defaults, ...options };
  const image = jpeg.decode(Buffer.from(frame.base64, "base64"), {
    useTArray: true,
    maxMemoryUsageInMB: 64,
  });
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  let samples = 0;
  for (let y = 0; y < image.height; y += settings.stride) {
    for (let x = 0; x < image.width; x += settings.stride) {
      samples += 1;
      const offset = (y * image.width + x) * 4;
      const brightest = Math.max(
        image.data[offset] ?? 0,
        image.data[offset + 1] ?? 0,
        image.data[offset + 2] ?? 0
      );
      if (brightest >= settings.minBrightness) {
        count += 1;
        sumX += x;
        sumY += y;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  // A bright region spanning most of the frame, covering a good part of it,
  // or running off its edge is the white table or wall, not a 2-3 cm piece;
  // report it as background instead of a detection. A wedge of table at the
  // mat edge once passed as the piece and the arm went to centre on it.
  const spanX = count > 0 ? (right - left) / image.width : 0;
  const spanY = count > 0 ? (bottom - top) / image.height : 0;
  const touchesEdge =
    count > 0 &&
    (left <= settings.stride ||
      top <= settings.stride ||
      right >= image.width - settings.stride * 2 ||
      bottom >= image.height - settings.stride * 2);
  const background =
    spanX >= settings.maxSpan ||
    spanY >= settings.maxSpan ||
    count / Math.max(1, samples) >= settings.maxArea ||
    touchesEdge;
  const visible = count >= settings.minPixels && !background;
  const nx = (x: number) => round((x / image.width) * 2 - 1);
  const ny = (y: number) => round((y / image.height) * 2 - 1);
  return {
    source: "white-blob/v1",
    camera: frame.camera,
    frame_id: frame.id,
    frame_seq: frame.seq,
    frame_age_ms: Math.round(frame.age_ms),
    visible,
    area_fraction: round(count / Math.max(1, samples)),
    center_x: visible ? nx(sumX / count) : null,
    center_y: visible ? ny(sumY / count) : null,
    bbox: visible ? [nx(left), ny(top), nx(right), ny(bottom)] : null,
    touches_edge: touchesEdge,
    background,
    frame: "image pixels, uncalibrated",
  };
};
