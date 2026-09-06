import { describe, expect, test } from "bun:test";
import {
  getCapability,
  issueCapability,
  sweepCapabilities,
} from "../src/server/capabilities";
describe("capabilities", () => {
  test("issued tokens resolve to a program principal until revoked", () => {
    const { token, revoke } = issueCapability("job", 60);
    expect(getCapability(token)).toEqual({
      owner: "program-job",
      human: false,
      program: true,
    });
    revoke();
    expect(getCapability(token)).toBeNull();
  });
  test("the sweep drops expired tokens that were never presented", () => {
    const { token } = issueCapability("forgotten", 1);
    expect(sweepCapabilities(Date.now())).toBeGreaterThanOrEqual(1);
    sweepCapabilities(Date.now() + 5000);
    expect(getCapability(token)).toBeNull();
    expect(sweepCapabilities(Date.now() + 5000)).toBe(0);
  });
});
