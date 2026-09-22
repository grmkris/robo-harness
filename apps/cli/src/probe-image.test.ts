import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";

import { redSquarePng } from "./probe-image";

test("the probe image is a valid 32x32 RGB PNG with a red centre on white", () => {
  const png = redSquarePng();
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR");
  expect([view.getUint32(16), view.getUint32(20)]).toEqual([32, 32]);
  // The IEND chunk's CRC is a fixed, well-known value.
  expect(view.getUint32(png.length - 4)).toBe(0xae_42_60_82);
  const idatLength = view.getUint32(33);
  const pixels = inflateSync(png.subarray(41, 41 + idatLength));
  const at = (x: number, y: number) => {
    const offset = y * (1 + 32 * 3) + 1 + x * 3;
    return [...pixels.subarray(offset, offset + 3)];
  };
  expect(at(0, 0)).toEqual([255, 255, 255]);
  expect(at(16, 16)).toEqual([220, 20, 20]);
});
