/** Offline orchestration fixture. No network, provider or motion adapter is installed. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Schema } from "effect";

import {
  decodeBenchConfig,
  makeSchedule,
  stopReason,
  type StopStatus,
  type TrialSlot,
} from "./bench";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Id = Schema.String.check(Schema.isMinLength(1));
const Home = Schema.Struct({
  reached: Schema.Literal(true),
  status: Schema.Literal("completed"),
});
const Capture = Schema.Struct({ workspace_id: Id, wrist_id: Id });
const Chat = Schema.Struct({
  session_id: Id,
  run_id: Id,
  finished: Schema.Literal(true),
  motion_outcomes_known: Schema.Literal(true),
  error: Schema.NullOr(Schema.Struct({ code: Id, message: Schema.String })),
  steps: Count,
  tool_calls: Count,
  invalid_inputs: Count,
  duration_ms: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  usage: Schema.Struct({
    input_tokens: Count,
    output_tokens: Count,
    calls: Count,
  }),
});
const Judgement = Schema.Struct({
  pick_success: Schema.NullOr(Schema.Boolean),
  place_error_m: Schema.NullOr(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  needs_review: Schema.Boolean,
});
const Reset = Schema.Struct({
  status: Schema.Literal("completed"),
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  final_xy_m: Schema.Tuple([Schema.Finite, Schema.Finite]),
});

interface Context {
  readonly slot: TrialSlot;
  readonly directory: string;
  readonly signal: AbortSignal;
}

interface MonitorState {
  checking: Promise<void> | null;
}

/** Test adapters only. In particular, passing this interface does not grant live admission. */
export interface OfflineBenchDriver {
  readonly health: (signal: AbortSignal) => Promise<StopStatus>;
  readonly home: (context: Context) => Promise<unknown>;
  /** Archive original frames in directory; return their source identities. */
  readonly capture: (
    context: Context,
    phase: "before" | "after"
  ) => Promise<unknown>;
  /** Save transcript/action ledger; return a matching terminal event, never an accepted request. */
  readonly chat: (
    context: Context & {
      readonly text: string;
      readonly stepCap: number;
      readonly wallMs: number;
      readonly toolErrorCap: number;
      readonly onEvent: (event: { type: string; data: unknown }) => void;
    }
  ) => Promise<unknown>;
  readonly judge: (context: Context) => Promise<unknown>;
  /** Same general tools, independent verification, at most three attempts. */
  readonly reset: (context: Context) => Promise<unknown>;
}

const save = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });

/**
 * Exercise the trial lifecycle with injected offline adapters. Existing evidence
 * always refuses a new run; a failed/unknown phase never triggers a reset or retry.
 * Adapters must observe cancellation and must not outlive the returned promise.
 */
export const runOfflineBench = async (options: {
  readonly config: unknown;
  readonly models: readonly string[];
  readonly count: number;
  readonly seed?: number;
  readonly directory: string;
  readonly driver: OfflineBenchDriver;
  readonly signal: AbortSignal;
  readonly wallMs?: number;
  readonly pollMs?: number;
}) => {
  options.signal.throwIfAborted();
  // Snapshot once: edits to caller-owned configuration cannot alter a run.
  const config = decodeBenchConfig(structuredClone(options.config));
  const schedule = makeSchedule(
    config,
    options.models,
    options.count,
    options.seed
  );
  const wallMs = options.wallMs ?? 300_000;
  const pollMs = options.pollMs ?? 1000;
  if (!Number.isSafeInteger(wallMs) || wallMs < 1 || wallMs > 1_800_000)
    throw new Error("Invalid fixture wall-clock cap");
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1000)
    throw new Error("Invalid fixture safety poll interval");
  const caps = { wall_ms: wallMs, step_cap: 80, tool_error_cap: 3 };
  mkdirSync(dirname(options.directory), { recursive: true, mode: 0o700 });
  mkdirSync(options.directory, { mode: 0o700 });
  save(join(options.directory, "manifest.json"), {
    kind: "offline_fixture",
    physical_admission: false,
    config,
    schedule,
    caps,
  });
  const logPath = join(options.directory, "events.jsonl");
  writeFileSync(logPath, "", { flag: "wx", mode: 0o600 });
  const log = (slot: TrialSlot, phase: string, data: unknown) =>
    appendFileSync(
      logPath,
      JSON.stringify({
        at: new Date().toISOString(),
        index: slot.index,
        phase,
        data,
      }) + "\n"
    );
  let completed = 0;
  const seenFrames = new Set<string>();
  const seenRuns = new Set<string>();
  const seenSessions = new Set<string>();
  for (const slot of schedule) {
    const directory = join(
      options.directory,
      `trial-${String(slot.index).padStart(2, "0")}`
    );
    mkdirSync(directory, { mode: 0o700 });
    save(join(directory, "started.json"), { kind: "offline_fixture", slot });
    const abort = new AbortController();
    const signal = AbortSignal.any([options.signal, abort.signal]);
    const context = { slot, directory, signal };
    const timeout = setTimeout(
      () => abort.abort(new Error("Trial wall-clock cap elapsed")),
      wallMs
    );
    const monitor: MonitorState = { checking: null };
    const check = async () => {
      signal.throwIfAborted();
      const status = await options.driver.health(signal);
      signal.throwIfAborted();
      const reason = stopReason(status, join(options.directory, "STOP"));
      if (reason) throw new Error(reason);
    };
    const poll = setInterval(() => {
      if (monitor.checking || signal.aborted) return;
      monitor.checking = check()
        .catch((error: unknown) => {
          abort.abort(error);
        })
        .finally(() => {
          monitor.checking = null;
        });
    }, pollMs);
    const phase = async <T>(name: string, action: () => Promise<T>) => {
      await check();
      log(slot, `${name}.started`, null);
      const result = await action();
      log(slot, `${name}.returned`, result);
      signal.throwIfAborted();
      return result;
    };
    const capture = async (name: "before" | "after") => {
      const raw = await phase(name, () =>
        options.driver.capture(context, name)
      );
      save(join(directory, `${name}.json`), raw);
      const result = Schema.decodeUnknownSync(Capture)(raw);
      for (const id of [result.workspace_id, result.wrist_id]) {
        if (seenFrames.has(id)) throw new Error("Reused benchmark frame");
        seenFrames.add(id);
      }
    };
    try {
      Schema.decodeUnknownSync(Home)(
        await phase("home", () => options.driver.home(context))
      );
      await capture("before");
      let errorStreak = 0;
      const rawChat = await phase("chat", () =>
        options.driver.chat({
          ...context,
          text: `Pick up the white block and place it at mat position (${slot.target[0]}, ${slot.target[1]}); return home.`,
          stepCap: caps.step_cap,
          wallMs,
          toolErrorCap: caps.tool_error_cap,
          onEvent: (event) => {
            log(slot, "chat.event", event);
            if (event.type === "chat.tool_result") errorStreak = 0;
            else if (event.type === "chat.tool_error") errorStreak += 1;
            if (errorStreak >= caps.tool_error_cap)
              abort.abort(new Error("Tool-error streak cap reached"));
          },
        })
      );
      save(join(directory, "chat.json"), rawChat);
      const chat = Schema.decodeUnknownSync(Chat)(rawChat);
      if (seenRuns.has(chat.run_id) || seenSessions.has(chat.session_id))
        throw new Error("Reused benchmark chat run or session");
      seenRuns.add(chat.run_id);
      seenSessions.add(chat.session_id);
      if (chat.error) throw new Error(`Chat ended with ${chat.error.code}`);
      if (chat.steps > caps.step_cap)
        throw new Error("Chat exceeded the step cap");
      await capture("after");
      const rawJudge = await phase("judge", () =>
        options.driver.judge(context)
      );
      save(join(directory, "judge.json"), rawJudge);
      const judgement = Schema.decodeUnknownSync(Judgement)(rawJudge);
      if (
        judgement.needs_review ||
        judgement.pick_success === null ||
        judgement.place_error_m === null
      )
        throw new Error("Judge outcome needs review");
      if (judgement.place_error_m > 0.03) {
        const rawReset = await phase("reset", () =>
          options.driver.reset(context)
        );
        save(join(directory, "reset.json"), rawReset);
        const reset = Schema.decodeUnknownSync(Reset)(rawReset);
        if (
          Math.hypot(
            reset.final_xy_m[0] - slot.target[0],
            reset.final_xy_m[1] - slot.target[1]
          ) > 0.03
        )
          throw new Error("Reset did not verify the scheduled position");
      }
      Schema.decodeUnknownSync(Home)(
        await phase("home", () => options.driver.home(context))
      );
      // A late health failure must not arrive after a completed artifact is written.
      clearInterval(poll);
      if (monitor.checking) await monitor.checking;
      await check();
      save(join(directory, "finished.json"), {
        status: "completed",
        kind: "offline_fixture",
        scored: false,
      });
      completed += 1;
    } catch (error) {
      abort.abort(error);
      const reason =
        error instanceof Error ? error.message : "Unknown fixture outcome";
      save(join(directory, "paused.json"), {
        status: "paused",
        reason,
        scored: false,
      });
      const result = {
        status: "paused" as const,
        completed,
        scored_trials: 0,
        reason,
      };
      save(join(options.directory, "result.json"), result);
      return result;
    } finally {
      clearTimeout(timeout);
      clearInterval(poll);
      // Wait for the one in-flight health read; no background task leaks to a later trial.
      if (monitor.checking) await monitor.checking;
    }
  }
  const result = { status: "completed" as const, completed, scored_trials: 0 };
  save(join(options.directory, "result.json"), result);
  return result;
};
