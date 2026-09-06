import { timingSafeEqual } from "node:crypto";
// Constant-time comparison of secrets. The length gate must compare bytes, not
// UTF-16 units: a multibyte probe used to reach timingSafeEqual with buffers of
// different lengths, which throws and turned a bad token into a 502.
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
