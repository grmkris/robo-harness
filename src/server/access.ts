import { timingSafeEqual } from "node:crypto";
// Constant-time comparison of secrets. The length gate must compare bytes, not
// UTF-16 units: a multibyte probe used to reach timingSafeEqual with buffers of
// different lengths, which throws and turned a bad token into a 502.
export function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const normalize = (ip: string) => (ip.startsWith("::ffff:") ? ip.slice(7) : ip);
export function isLoopback(ip: string) {
  const address = normalize(ip);
  return address === "::1" || address.startsWith("127.");
}
// Tailscale assigns 100.64.0.0/10 (the CGNAT range) and fd7a:115c:a1e0::/48.
export function isTailnetAddress(ip: string) {
  const address = normalize(ip);
  return (
    /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(
      address
    ) || address.toLowerCase().startsWith("fd7a:115c:a1e0:")
  );
}
export interface Trust {
  // Loopback peers are operators only when the server itself is bound to
  // loopback (nothing else can reach it) or the deployment opted in.
  loopback: boolean;
  // Addresses that are never treated as a human operator, such as the robot host.
  blocked: ReadonlySet<string>;
}
export function trustedSource(ip: string, trust: Trust) {
  const address = normalize(ip);
  if (!address || trust.blocked.has(address)) {
    return false;
  }
  if (isLoopback(address)) {
    return trust.loopback;
  }
  return isTailnetAddress(address);
}
// An event cursor from a client. Anything that is not a non-negative integer
// means "from the beginning"; NaN used to be bound into the query and return
// nothing, so a client resuming with a bad Last-Event-ID silently lost history.
export function parseCursor(value: string | null | undefined) {
  const n = Number(value ?? 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
