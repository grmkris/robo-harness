import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOfflineBench, type OfflineBenchDriver } from "./bench-runner";

const config = {
  commissioned: true,
  safe_zone: {
    polygon: [
      [0.04, -0.12],
      [0.17, -0.12],
      [0.17, 0.12],
      [0.04, 0.12],
    ],
    max_radius_m: 0.17,
  },
  home_pose: {
    shoulder_pan: 0,
    shoulder_lift: -40,
    elbow_flex: 50,
    wrist_flex: 80,
    wrist_roll: 0,
  },
  tcp_offset_m: [0, 0, 0.023],
  workspace_table_homography: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
};

const status = {
  fault: null,
  temperatures: {
    shoulder_pan: 40,
    shoulder_lift: 40,
    elbow_flex: 40,
    wrist_flex: 40,
    wrist_roll: 40,
    gripper: 40,
  },
  cameras: {
    workspace: { age_ms: 20, error: null },
    wrist: { age_ms: 20, error: null },
  },
};

const chat = {
  session_id: "session-1",
  run_id: "run-1",
  finished: true,
  motion_outcomes_known: true,
  error: null,
  steps: 4,
  tool_calls: 4,
  invalid_inputs: 0,
  duration_ms: 100,
  usage: { input_tokens: 10, output_tokens: 20, calls: 2 },
};

const makeDriver = (
  options: { placeError?: number; chatError?: string } = {}
) => {
  const calls: string[] = [];
  let captureNumber = 0;
  const driver: OfflineBenchDriver = {
    health: async () => status,
    home: async () => {
      calls.push("home");
      return { reached: true, status: "completed" };
    },
    capture: async (_context, phase) => {
      calls.push(`capture:${phase}`);
      captureNumber += 1;
      return {
        workspace_id: `workspace-${captureNumber}`,
        wrist_id: `wrist-${captureNumber}`,
      };
    },
    chat: async (context) => {
      calls.push("chat");
      context.onEvent({ type: "chat.tool_result", data: { name: "observe" } });
      return {
        ...chat,
        session_id: `session-${context.slot.index + 1}`,
        run_id: `run-${context.slot.index + 1}`,
        error: options.chatError
          ? { code: options.chatError, message: "fixture" }
          : null,
      };
    },
    judge: async () => {
      calls.push("judge");
      return {
        pick_success: true,
        place_error_m: options.placeError ?? 0.001,
        needs_review: false,
      };
    },
    reset: async (context) => {
      calls.push("reset");
      return {
        status: "completed",
        attempts: 1,
        final_xy_m: context.slot.target,
      };
    },
  };
  return { driver, calls };
};

const paused = (result: Awaited<ReturnType<typeof runOfflineBench>>) => {
  if (result.status !== "paused") throw new Error("Expected paused fixture");
  return result;
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

test("offline runner sequences evidence and leaves scored trials at zero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bench-runner-"));
  directories.push(directory);
  const fixture = makeDriver({ placeError: 0.04 });
  const result = await runOfflineBench({
    config,
    models: ["gpt-6-astra"],
    count: 1,
    seed: 7,
    directory: join(directory, "run"),
    driver: fixture.driver,
    signal: new AbortController().signal,
    pollMs: 1,
  });
  expect(result).toEqual({
    status: "completed",
    completed: 1,
    scored_trials: 0,
  });
  expect(fixture.calls).toEqual([
    "home",
    "capture:before",
    "chat",
    "capture:after",
    "judge",
    "reset",
    "home",
  ]);
  expect(
    await readFile(join(directory, "run", "trial-00", "chat.json"), "utf-8")
  ).toContain("session-1");
  expect(
    await readFile(join(directory, "run", "trial-00", "reset.json"), "utf-8")
  ).toContain("completed");
});

test("unknown chat outcome pauses without after capture, judge or reset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bench-runner-"));
  directories.push(directory);
  const fixture = makeDriver({ chatError: "UNKNOWN" });
  const result = await runOfflineBench({
    config,
    models: ["grok-4.7"],
    count: 1,
    directory: join(directory, "run"),
    driver: fixture.driver,
    signal: new AbortController().signal,
    pollMs: 1,
  });
  expect(result.status).toBe("paused");
  expect(paused(result).reason).toContain("UNKNOWN");
  expect(fixture.calls).toEqual(["home", "capture:before", "chat"]);
  expect(
    await readFile(join(directory, "run", "trial-00", "paused.json"), "utf-8")
  ).toContain("UNKNOWN");
});

test("the fail-closed stop guard prevents a trial from starting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bench-runner-"));
  directories.push(directory);
  const fixture = makeDriver();
  const result = await runOfflineBench({
    config,
    models: ["qwen3.8-max"],
    count: 1,
    directory: join(directory, "run"),
    driver: {
      ...fixture.driver,
      health: async () => ({ ...status, fault: "latched" }),
    },
    signal: new AbortController().signal,
  });
  expect(result.status).toBe("paused");
  expect(paused(result).reason).toContain("latched fault");
  expect(fixture.calls).toEqual([]);
});

const pendingUntilAbort = (signal: AbortSignal): Promise<never> => {
  signal.throwIfAborted();
  const pending = Promise.withResolvers<never>();
  signal.addEventListener("abort", () => pending.reject(signal.reason), {
    once: true,
  });
  return pending.promise;
};

test("STOP, hot servo and the wall cap cancel a pending trial without resetting", async () => {
  for (const condition of ["STOP", "hot", "deadline"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "bench-interrupted-"));
    directories.push(directory);
    const fixture = makeDriver();
    let chatting = false;
    const result = await runOfflineBench({
      config,
      models: ["fixture"],
      count: 2,
      directory: join(directory, "run"),
      signal: new AbortController().signal,
      pollMs: 5,
      wallMs: condition === "deadline" ? 100 : 1000,
      driver: {
        ...fixture.driver,
        health: async () =>
          chatting && condition === "hot"
            ? {
                ...status,
                temperatures: { ...status.temperatures, elbow_flex: 61 },
              }
            : status,
        chat: async ({ signal }) => {
          fixture.calls.push("chat");
          chatting = true;
          if (condition === "STOP")
            writeFileSync(join(directory, "run", "STOP"), "");
          return pendingUntilAbort(signal);
        },
      },
    });
    expect(result.status).toBe("paused");
    expect(result.completed).toBe(0);
    expect(paused(result).reason).toContain(
      condition === "STOP"
        ? "STOP"
        : condition === "hot"
          ? "temperature"
          : "wall-clock"
    );
    expect(fixture.calls).toEqual(["home", "capture:before", "chat"]);
  }
});

test("three consecutive tool errors cancel, but successful results reset the streak", async () => {
  for (const recover of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "bench-errors-"));
    directories.push(directory);
    const fixture = makeDriver();
    const result = await runOfflineBench({
      config,
      models: ["fixture"],
      count: 1,
      directory: join(directory, "run"),
      signal: new AbortController().signal,
      driver: {
        ...fixture.driver,
        chat: async ({ signal, onEvent }) => {
          fixture.calls.push("chat");
          for (let i = 0; i < 3; i += 1) {
            onEvent({
              type: "chat.tool_error",
              data: { code: "INVALID_INPUT" },
            });
            if (recover)
              onEvent({ type: "chat.tool_result", data: { name: "observe" } });
          }
          signal.throwIfAborted();
          return chat;
        },
      },
    });
    expect(result.status).toBe(recover ? "completed" : "paused");
    if (!recover)
      expect(fixture.calls).toEqual(["home", "capture:before", "chat"]);
    expect(
      await readFile(join(directory, "run", "events.jsonl"), "utf-8")
    ).toContain("INVALID_INPUT");
  }
});

test("malformed terminal evidence, reused frames and uncertain judgement never reset", async () => {
  for (const condition of [
    "accepted",
    "motion_unknown",
    "reused",
    "judge_null",
    "home_failed",
  ] as const) {
    const directory = await mkdtemp(join(tmpdir(), "bench-unverified-"));
    directories.push(directory);
    const fixture = makeDriver();
    const driver: OfflineBenchDriver = {
      ...fixture.driver,
      ...(condition === "accepted"
        ? { chat: async () => ({ ...chat, finished: false }) }
        : {}),
      ...(condition === "motion_unknown"
        ? { chat: async () => ({ ...chat, motion_outcomes_known: false }) }
        : {}),
      ...(condition === "reused"
        ? {
            capture: async () => ({
              workspace_id: "same",
              wrist_id: "same-wrist",
            }),
          }
        : {}),
      ...(condition === "judge_null"
        ? {
            judge: async () => ({
              pick_success: null,
              place_error_m: 0.04,
              needs_review: false,
            }),
          }
        : {}),
      ...(condition === "home_failed"
        ? { home: async () => ({ reached: false, status: "unknown" }) }
        : {}),
    };
    const result = await runOfflineBench({
      config,
      models: ["fixture"],
      count: 2,
      directory: join(directory, "run"),
      driver,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("paused");
    expect(result.completed).toBe(0);
    expect(fixture.calls).not.toContain("reset");
  }
});

test("failed reset and a reset outside tolerance prevent the next trial", async () => {
  for (const outcome of [
    { status: "paused", attempts: 3, reason: "not verified" },
    { status: "completed", attempts: 1, final_xy_m: [1, 1] },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "bench-reset-stop-"));
    directories.push(directory);
    const fixture = makeDriver({ placeError: 0.04 });
    const result = await runOfflineBench({
      config,
      models: ["fixture"],
      count: 2,
      directory: join(directory, "run"),
      driver: { ...fixture.driver, reset: async () => outcome },
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("paused");
    expect(result.completed).toBe(0);
    expect(fixture.calls.filter((call) => call === "chat")).toHaveLength(1);
  }
});

test("existing evidence and uncommissioned config refuse before any adapter call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bench-reservation-"));
  directories.push(directory);
  let called = false;
  const fixture = makeDriver();
  const options = {
    config,
    models: ["fixture"],
    count: 1,
    directory,
    signal: new AbortController().signal,
    driver: {
      ...fixture.driver,
      health: async () => {
        called = true;
        return status;
      },
    },
  };
  await Promise.resolve(
    expect(runOfflineBench(options)).rejects.toThrow("EEXIST")
  );
  await Promise.resolve(
    expect(
      runOfflineBench({
        ...options,
        config: { ...config, commissioned: false },
      })
    ).rejects.toThrow("uncommissioned")
  );
  expect(called).toBe(false);
  expect(fixture.calls).toEqual([]);
});

test("model rotation uses fresh sessions and identical caps, and refuses a reused terminal run", async () => {
  for (const reuse of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "bench-rotation-"));
    directories.push(directory);
    const fixture = makeDriver();
    const requests: {
      model: string;
      steps: number;
      wall: number;
      errors: number;
    }[] = [];
    const result = await runOfflineBench({
      config,
      models: ["astra", "grok", "qwen"],
      count: 3,
      directory: join(directory, "run"),
      signal: new AbortController().signal,
      driver: {
        ...fixture.driver,
        chat: async (context) => {
          requests.push({
            model: context.slot.model,
            steps: context.stepCap,
            wall: context.wallMs,
            errors: context.toolErrorCap,
          });
          return reuse ? chat : fixture.driver.chat(context);
        },
      },
    });
    expect(result.status).toBe(reuse ? "paused" : "completed");
    expect(result.completed).toBe(reuse ? 1 : 3);
    expect(requests).toEqual(
      (reuse ? ["astra", "grok"] : ["astra", "grok", "qwen"]).map((model) => ({
        model,
        steps: 80,
        wall: 300_000,
        errors: 3,
      }))
    );
  }
});

test("a health failure already in flight prevents a completed artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bench-late-health-"));
  directories.push(directory);
  const fixture = makeDriver();
  let chatting = false;
  let delayed = false;
  const result = await runOfflineBench({
    config,
    models: ["fixture"],
    count: 1,
    directory: join(directory, "run"),
    signal: new AbortController().signal,
    pollMs: 1,
    driver: {
      ...fixture.driver,
      health: async () => {
        if (chatting && !delayed) {
          delayed = true;
          await Bun.sleep(50);
          return { ...status, fault: "late health failure" };
        }
        return status;
      },
      chat: async (context) => {
        chatting = true;
        await Bun.sleep(10);
        return fixture.driver.chat(context);
      },
    },
  });
  expect(paused(result).reason).toContain("late health failure");
  expect(result.completed).toBe(0);
  expect(
    await Bun.file(join(directory, "run", "trial-00", "finished.json")).exists()
  ).toBe(false);
});
