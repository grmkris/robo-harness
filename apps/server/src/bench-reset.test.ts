import { expect, test } from "bun:test";

import { resetObject, type ResetIO } from "./bench-reset";
import { decodeManipulationConfig } from "./manipulation-config";

// Deliberately synthetic commissioning. These test the fixture protocol, not hardware.
const config = decodeManipulationConfig({
  commissioned: true,
  tcp_offset_m: [0, 0, 0.023],
  home_pose: {
    shoulder_pan: 0,
    shoulder_lift: -40,
    elbow_flex: 50,
    wrist_flex: 80,
    wrist_roll: 0,
  },
  workspace_table_homography: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  safe_zone: {
    polygon: [
      [0.05, -0.08],
      [0.17, -0.08],
      [0.17, 0.08],
      [0.05, 0.08],
    ],
    max_radius_m: 0.17,
  },
});
const source = [0.11, -0.03] as const;
const target = [0.13, 0.03] as const;
const fixture = (
  options: {
    failAt?: number;
    contact?: boolean | null;
    held?: boolean | null;
    placed?: boolean;
  } = {}
) => {
  const calls: { name: string; input: unknown }[] = [];
  const checks: string[] = [];
  let observed = 0;
  const io: ResetIO = {
    motion: async (name, input) => {
      calls.push({ name, input });
      if (calls.length === options.failAt)
        return { reached: false, status: "unknown" };
      if (name === "descend_until_contact")
        return {
          reached: false,
          status: "failed",
          contact: true,
          stopped: "first_failed_step",
        };
      if (name === "gripper" && "percent" in input && input.percent === 0)
        return {
          reached: false,
          status: "failed",
          contact: true,
          stalled_at: 12,
        };
      return { reached: true, status: "completed" };
    },
    locate: async () => {
      observed += 1;
      checks.push("locate");
      return {
        xy_m: observed >= 3 && options.placed !== false ? target : source,
        frame_id: `fixture-${observed}`,
        on_table: true,
      };
    },
    confirmContact: async (phase) => {
      checks.push(`${phase}-contact`);
      return options.contact === undefined ? true : options.contact;
    },
    verifyHeld: async () => {
      checks.push("held");
      return options.held === undefined ? true : options.held;
    },
  };
  return { io, calls, checks };
};

test("reset approaches the observed source, verifies lift, then places at the target", async () => {
  const f = fixture();
  const result = await resetObject(
    config,
    target,
    f.io,
    new AbortController().signal
  );
  expect(result.status).toBe("completed");
  expect(result.attempts).toBe(1);
  expect(
    f.calls.filter((call) => call.name === "move_tcp").map((call) => call.input)
  ).toEqual([
    { x: source[0], y: source[1], z: config.table_z_m + 0.05 },
    { x: source[0], y: source[1], z: config.table_z_m + 0.05 },
    { x: target[0], y: target[1], z: config.table_z_m + 0.05 },
    { x: target[0], y: target[1], z: config.table_z_m + 0.05 },
  ]);
  expect(f.checks).toEqual([
    "locate",
    "locate",
    "pick-contact",
    "held",
    "place-contact",
    "locate",
  ]);
  expect(f.calls.at(-1)?.name).toBe("home");
});

test("unknown motion and unverified contact/lift stop before any later action", async () => {
  for (const [options, expectedCalls] of [
    [{ failAt: 3 }, 3],
    [{ contact: null }, 4],
    [{ held: false }, 6],
  ] as const) {
    const f = fixture(options);
    const result = await resetObject(
      config,
      target,
      f.io,
      new AbortController().signal
    );
    expect(result.status).toBe("paused");
    expect(f.calls).toHaveLength(expectedCalls);
  }
});

test("known failed placements are capped at three attempts, with new observations", async () => {
  const f = fixture({ placed: false });
  const result = await resetObject(
    config,
    target,
    f.io,
    new AbortController().signal
  );
  expect(result.status).toBe("paused");
  expect(result.attempts).toBe(3);
  expect(f.checks.filter((check) => check === "held")).toHaveLength(3);
  expect(f.calls.at(-1)?.name).toBe("home");
});

test("commissioning, unknown position, reused frames and pre-abort cannot start a reset", async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  expect(
    (
      await resetObject(
        { ...config, commissioned: false },
        target,
        f.io,
        signal
      )
    ).status
  ).toBe("paused");
  expect(f.calls).toHaveLength(0);
  expect(
    (
      await resetObject(
        config,
        target,
        { ...f.io, locate: async () => null },
        signal
      )
    ).status
  ).toBe("paused");
  expect(f.calls).toHaveLength(0);
  const abort = new AbortController();
  abort.abort();
  expect((await resetObject(config, target, f.io, abort.signal)).status).toBe(
    "paused"
  );
  expect(f.calls).toHaveLength(0);
  const stale = await resetObject(
    config,
    target,
    {
      ...f.io,
      locate: async () => ({ xy_m: source, frame_id: "same", on_table: true }),
    },
    signal
  );
  expect(stale.status).toBe("paused");
  // No descent is allowed on a reused alignment frame.
  expect(f.calls).toHaveLength(3);
});
