import { randomBytes } from "node:crypto";
const capabilities = new Map<string, { owner: string; expires: number }>();
export function issueCapability(owner: string, seconds: number) {
  const token = randomBytes(32).toString("hex");
  capabilities.set(token, {
    owner: "program-" + owner,
    expires: Date.now() + seconds * 1000,
  });
  return { token, revoke: () => capabilities.delete(token) };
}
export function getCapability(token: string) {
  const value = capabilities.get(token);
  if (!value) return null;
  if (value.expires < Date.now()) {
    capabilities.delete(token);
    return null;
  }
  return { owner: value.owner, human: false, program: true };
}
// Expired tokens are otherwise only removed when presented; the sweeper keeps a
// forgotten issue from lingering for the life of the process.
export function sweepCapabilities(now = Date.now()) {
  for (const [token, value] of capabilities)
    if (value.expires < now) capabilities.delete(token);
  return capabilities.size;
}
