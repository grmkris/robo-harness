import type { Frame } from "@robo/domain";
import jpeg from "jpeg-js";

import type { Detection } from "./state";

export interface BlobOptions {
  /** A pixel counts as bright when its brightest channel reaches this. The
   *  wrist camera has a strong blue cast (a white object reads ~50/160/200). */
  readonly minBrightness: number;
  /** Sample every Nth pixel in each direction; components are labelled on this grid. */
  readonly stride: number;
  /** Minimum sampled pixels for a component to count. */
  readonly minPixels: number;
  /** Components spanning at least this fraction of the frame width or height are background. */
  readonly maxSpan: number;
  /** Components covering at least this fraction of the frame are background. */
  readonly maxArea: number;
  /**
   * A component whose contact with one frame edge is at least this fraction
   * of that edge is background running out of view (a table, a wall). A
   * shorter contact is kept: on 2026-09-22 the object sat against the left
   * edge of the wrist image for its whole visible window, so "touches the
   * edge" alone would have thrown away the only true detection.
   */
  readonly maxEdgeContact: number;
  /** A sample darker than this (brightest channel) counts as dark surround. */
  readonly darkMax: number;
  /**
   * Fraction of the ring around a component that must be dark. An object on
   * the mat is ringed by mat; a patch of table cut off by a cable or a shadow
   * is ringed by more table, only dimmer. Without this, fragments of table
   * between a cable and the mat edge read as objects.
   */
  readonly minDarkSurround: number;
}

const defaults: BlobOptions = {
  minBrightness: 130,
  stride: 4,
  minPixels: 40,
  maxSpan: 0.8,
  maxArea: 0.12,
  maxEdgeContact: 0.3,
  darkMax: 70,
  minDarkSurround: 0.6,
};

/** Width of the ring around a component that must be dark, in grid samples. */
const RING = 3;

type Rejection = "too_small" | "too_large" | "edge" | "not_isolated";

/** One connected bright region, in pixels of the source frame. */
interface BrightComponent {
  readonly pixels: number;
  readonly areaFraction: number;
  readonly centerX: number;
  readonly centerY: number;
  /** [left, top, right, bottom], inclusive sample coordinates. */
  readonly bbox: readonly [number, number, number, number];
  /** Frame edges the component reaches: left, top, right, bottom. */
  readonly edges: readonly ("left" | "top" | "right" | "bottom")[];
  /** Fraction of the ring around the box that is dark. */
  readonly darkSurround: number;
  readonly rejected: Rejection | null;
}

export interface Components {
  readonly width: number;
  readonly height: number;
  /** Largest component that is not background, or null. */
  readonly best: BrightComponent | null;
  /** Every component of at least two samples, largest first. */
  readonly candidates: readonly BrightComponent[];
  /** Some bright region was rejected as background (too large or running off the frame). */
  readonly background: boolean;
}

/**
 * Connected bright regions in one camera frame.
 *
 * The previous detector took one bounding box over every bright pixel in the
 * frame, so a strip of white table anywhere in view turned every frame into
 * "background" and hid an object on the mat beside it. Labelling the regions
 * separately lets the table be rejected on its own while a small region is
 * still reported.
 *
 * Brightness alone cannot tell every fragment of table from an object: a
 * patch of table walled in by a dark cable or the gripper finger is bright,
 * compact and ringed by dark, and still passes (seen in the same recording
 * with the camera over the table edge). Treat a detection as a candidate to
 * look at, not as proof of an object.
 */
export const brightComponents = (
  frame: Frame,
  options: Partial<BlobOptions> = {}
): Components => {
  const settings = { ...defaults, ...options };
  const image = jpeg.decode(Buffer.from(frame.base64, "base64"), {
    useTArray: true,
    maxMemoryUsageInMB: 64,
  });
  const stride = Math.max(1, Math.round(settings.stride));
  const gw = Math.ceil(image.width / stride);
  const gh = Math.ceil(image.height / stride);
  const bright = new Uint8Array(gw * gh);
  const level = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      const offset = (gy * stride * image.width + gx * stride) * 4;
      const brightest = Math.max(
        image.data[offset] ?? 0,
        image.data[offset + 1] ?? 0,
        image.data[offset + 2] ?? 0
      );
      level[gy * gw + gx] = brightest;
      if (brightest >= settings.minBrightness) bright[gy * gw + gx] = 1;
    }
  }
  const label = new Int32Array(gw * gh).fill(-1);
  const queue = new Int32Array(gw * gh);
  const found: BrightComponent[] = [];
  const total = gw * gh;
  for (let start = 0; start < total; start += 1) {
    if (!bright[start] || label[start] !== -1) continue;
    const id = found.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = id;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let left = gw;
    let top = gh;
    let right = -1;
    let bottom = -1;
    const contact = { left: 0, top: 0, right: 0, bottom: 0 };
    while (head < tail) {
      const cell = queue[head++] ?? 0;
      const gx = cell % gw;
      const gy = (cell - gx) / gw;
      count += 1;
      sumX += gx;
      sumY += gy;
      left = Math.min(left, gx);
      top = Math.min(top, gy);
      right = Math.max(right, gx);
      bottom = Math.max(bottom, gy);
      if (gx === 0) contact.left += 1;
      if (gy === 0) contact.top += 1;
      if (gx === gw - 1) contact.right += 1;
      if (gy === gh - 1) contact.bottom += 1;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const next = ny * gw + nx;
          if (bright[next] && label[next] === -1) {
            label[next] = id;
            queue[tail++] = next;
          }
        }
      }
    }
    const edges = (["left", "top", "right", "bottom"] as const).filter(
      (edge) => contact[edge] > 0
    );
    const areaFraction = count / total;
    const spanX = (right - left + 1) / gw;
    const spanY = (bottom - top + 1) / gh;
    const longContact =
      contact.left / gh >= settings.maxEdgeContact ||
      contact.right / gh >= settings.maxEdgeContact ||
      contact.top / gw >= settings.maxEdgeContact ||
      contact.bottom / gw >= settings.maxEdgeContact;
    // Fraction of the ring around the component's box that is dark.
    let ring = 0;
    let dark = 0;
    for (
      let gy = Math.max(0, top - RING);
      gy <= Math.min(gh - 1, bottom + RING);
      gy += 1
    ) {
      for (
        let gx = Math.max(0, left - RING);
        gx <= Math.min(gw - 1, right + RING);
        gx += 1
      ) {
        const inside = gx >= left && gx <= right && gy >= top && gy <= bottom;
        if (inside) continue;
        const cell = gy * gw + gx;
        if (label[cell] === id) continue;
        ring += 1;
        if ((level[cell] ?? 0) <= settings.darkMax) dark += 1;
      }
    }
    const darkSurround = ring > 0 ? dark / ring : 0;
    let rejected: Rejection | null = null;
    if (
      areaFraction >= settings.maxArea ||
      spanX >= settings.maxSpan ||
      spanY >= settings.maxSpan
    ) {
      rejected = "too_large";
    } else if (edges.length >= 2 || longContact) {
      // Reaching two edges is a corner wedge of background, not an object in
      // view; one long contact is background running out of frame.
      rejected = "edge";
    } else if (count < settings.minPixels) {
      rejected = "too_small";
    } else if (darkSurround < settings.minDarkSurround) {
      rejected = "not_isolated";
    }
    found.push({
      pixels: count,
      areaFraction,
      centerX: (sumX / count) * stride,
      centerY: (sumY / count) * stride,
      bbox: [left * stride, top * stride, right * stride, bottom * stride],
      edges,
      darkSurround,
      rejected,
    });
  }
  const candidates = found
    .filter((component) => component.pixels >= 2)
    .toSorted((a, b) => b.pixels - a.pixels);
  return {
    width: image.width,
    height: image.height,
    best: candidates.find((component) => component.rejected === null) ?? null,
    candidates,
    background: candidates.some(
      (component) =>
        component.rejected === "too_large" || component.rejected === "edge"
    ),
  };
};

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Bright object on the dark mat in one camera frame. Coordinates are image
 * offsets from the frame centre in [-1, 1] (+x right, +y down); they are not
 * robot coordinates and their relation to joint motion is uncalibrated.
 *
 * `background` is true only when nothing but background is bright: a table
 * strip beside a real object no longer hides it.
 */
export const whiteBlob = (
  frame: Frame,
  options: Partial<BlobOptions> = {}
): Detection => {
  const found = brightComponents(frame, options);
  const { best } = found;
  const nx = (x: number) => round((x / found.width) * 2 - 1);
  const ny = (y: number) => round((y / found.height) * 2 - 1);
  return {
    source: "white-blob/v1",
    method: "connected-components",
    camera: frame.camera,
    frame_id: frame.id,
    frame_seq: frame.seq,
    frame_age_ms: Math.round(frame.age_ms),
    visible: best !== null,
    area_fraction: round(best?.areaFraction ?? 0),
    center_x: best ? nx(best.centerX) : null,
    center_y: best ? ny(best.centerY) : null,
    bbox: best
      ? [nx(best.bbox[0]), ny(best.bbox[1]), nx(best.bbox[2]), ny(best.bbox[3])]
      : null,
    touches_edge: best ? best.edges.length > 0 : found.background,
    background: best === null && found.background,
    candidates: found.candidates.length,
    frame: "image pixels, uncalibrated",
  };
};
