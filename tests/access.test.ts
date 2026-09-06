import { describe, expect, test } from "bun:test";
import {
  equal,
  isTailnetAddress,
  parseCursor,
  trustedSource,
} from "../src/server/access";
describe("trustedSource", () => {
  const trust = { loopback: false, blocked: new Set(["100.77.154.45"]) };
  test("accepts tailnet peers only", () => {
    expect(trustedSource("100.105.51.45", trust)).toBe(true);
    expect(trustedSource("::ffff:100.105.51.46", trust)).toBe(true);
    expect(trustedSource("fd7a:115c:a1e0::1", trust)).toBe(true);
    expect(trustedSource("172.17.0.2", trust)).toBe(false);
    expect(trustedSource("10.0.0.7", trust)).toBe(false);
    expect(trustedSource("", trust)).toBe(false);
  });
  test("never trusts the robot host and trusts loopback only when bound there", () => {
    expect(trustedSource("100.77.154.45", trust)).toBe(false);
    expect(trustedSource("127.0.0.1", trust)).toBe(false);
    expect(trustedSource("::ffff:127.0.0.1", { ...trust, loopback: true })).toBe(true);
  });
  test("bounds the CGNAT range precisely", () => {
    expect(isTailnetAddress("100.64.0.0")).toBe(true);
    expect(isTailnetAddress("100.127.255.255")).toBe(true);
    expect(isTailnetAddress("100.128.0.1")).toBe(false);
    expect(isTailnetAddress("100.63.255.255")).toBe(false);
  });
});
describe("equal", () => {
  test("compares by byte and never throws on multibyte input", () => {
    expect(equal("éé", "ab")).toBe(false);
    expect(equal("éé", "éé")).toBe(true);
    expect(equal("", "a")).toBe(false);
  });
});
describe("parseCursor", () => {
  test("accepts non-negative integers and falls back to the beginning", () => {
    expect(parseCursor("42")).toBe(42);
    expect(parseCursor(null)).toBe(0);
    expect(parseCursor("abc")).toBe(0);
    expect(parseCursor("-5")).toBe(0);
    expect(parseCursor("1.5")).toBe(0);
    expect(parseCursor("Infinity")).toBe(0);
  });
});
