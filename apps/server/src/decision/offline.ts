import type { WireAnswer } from "@tanstack/ai";

import { candidates, defaultLimits, type Action } from "./candidates";
import { fixtures } from "./fixtures";
import {
  choiceAnswer,
  fallbackRate,
  DecideFailure,
  jevEvaluator,
  jevRate,
  memoryMeter,
  type Evaluator,
  type SpendMeter,
} from "./jev";
import { localAdapter, mockEvaluator } from "./mock";
import { sqliteMeter } from "./spend";
import { decisionState } from "./state";
import { deciderFor, type StrategyName } from "./strategies";
import { stageTracker } from "./tasks";

export type DeciderKind = "jev" | "mock";

const aiVersion = async () => {
  const pkg = (await Bun.file(
    new URL("../../node_modules/@tanstack/ai/package.json", import.meta.url)
  ).json()) as { version?: string };
  return pkg.version ?? "unknown";
};

const smokeCriteria = {
  reobserve: "Obtain a fresh observation before deciding.",
  inspect: "Inspect the object using current, usable observations.",
};

/** Gateway proof from the brief: a static fixture that never reaches motion. */
export const runSmoke = async (kind: DeciderKind, timeoutMs = 8000) => {
  const rate = kind === "jev" ? await jevRate() : fallbackRate;
  const meter: SpendMeter =
    kind === "jev" ? sqliteMeter(rate) : memoryMeter(rate, 1);
  const answer: WireAnswer = {
    type: "choice",
    choice: "reobserve",
    confidence: 1,
    probabilities: { reobserve: 0.97, inspect: 0.03 },
  };
  const evaluate =
    kind === "jev"
      ? jevEvaluator({ meter, timeoutMs })
      : jevEvaluator({
          meter,
          adapter: localAdapter(() =>
            Promise.resolve({
              answers: { nextAction: answer },
              usage: { promptTokens: 60, completionTokens: 0, totalTokens: 60 },
              model: "mock-jev",
            })
          ),
        });
  const base = {
    step: "gateway_proof",
    decider: kind,
    tanstack_ai: await aiVersion(),
    rate,
  };
  try {
    const outcome = await evaluate({
      state: { fixture: true, frameStatus: "stale", task: "inspect a cube" },
      questions: {
        nextAction: {
          type: "choice",
          instructions: "Choose the next action from the supplied evidence.",
          criteria: smokeCriteria,
        },
      },
      signal: AbortSignal.timeout(timeoutMs + 1000),
    });
    const checked = choiceAnswer(
      outcome.answers["nextAction"],
      Object.keys(smokeCriteria)
    );
    return {
      ...base,
      status: "passed",
      model: outcome.model,
      answer: checked,
      matches_expected: checked.value === "reobserve",
      latency_ms: outcome.latency_ms,
      usage: outcome.usage,
      cost_usd: outcome.cost_usd,
      spend: meter.summary(),
    };
  } catch (error) {
    const failure =
      error instanceof DecideFailure
        ? error
        : new DecideFailure("provider", String(error));
    return {
      ...base,
      status: failure.kind === "missing_credentials" ? "blocked" : "failed",
      failure: failure.kind,
      error: failure.message,
      ...(failure.kind === "missing_credentials"
        ? {
            setup:
              "Add AI_GATEWAY_API_KEY to ~/.config/robo-harness.env (the robo-app EnvironmentFile), then systemctl --user restart robo-app",
          }
        : {}),
    };
  }
};

interface FixtureRow {
  readonly fixture: string;
  readonly acceptable: readonly string[];
  readonly choice?: string;
  readonly ok?: boolean;
  readonly note?: string | null;
  readonly latency_ms?: number;
  readonly failure?: string;
  readonly error?: string;
}

/** Run every offline fixture through one strategy/decider; no robot involved. */
export const runFixtures = async (
  strategy: StrategyName,
  kind: DeciderKind,
  signal: AbortSignal,
  timeoutMs = 8000
) => {
  const rate = kind === "jev" ? await jevRate() : fallbackRate;
  let offered: readonly Action[] = [];
  const evaluate: Evaluator =
    kind === "jev"
      ? jevEvaluator({ meter: sqliteMeter(rate), timeoutMs })
      : mockEvaluator(memoryMeter(rate, 1), () => offered);
  const decider = deciderFor(strategy, evaluate);
  const rows: FixtureRow[] = [];
  let cost = 0;
  const latencies: number[] = [];
  for (const item of fixtures) {
    const task = {
      name: "control-smoke" as const,
      description:
        "Reach the goal joint pose using only the offered bounded steps. No object is involved.",
      stages: [item.goal],
      explore: [],
      start: item.obs.measured,
    };
    const view = stageTracker(task, defaultLimits).advance(item.obs, []);
    offered = candidates(
      item.obs,
      { goal: view.goal, explore: view.explore },
      defaultLimits
    );
    const state = decisionState({
      obs: item.obs,
      task,
      view,
      limits: defaultLimits,
      previous: item.previous,
      progress: {
        step: 1,
        max_steps: 10,
        executed: 0,
        completed: 0,
        consecutive_failures: item.consecutiveFailures,
      },
    });
    try {
      const decision = await decider.decide({ state, offered, signal });
      cost += decision.cost_usd;
      latencies.push(decision.latency_ms);
      rows.push({
        fixture: item.name,
        acceptable: item.acceptable,
        choice: decision.action_id,
        ok: item.acceptable.includes(decision.action_id),
        note: decision.note,
        latency_ms: decision.latency_ms,
      });
    } catch (error) {
      const failure =
        error instanceof DecideFailure
          ? error
          : new DecideFailure("provider", String(error));
      rows.push({
        fixture: item.name,
        acceptable: item.acceptable,
        failure: failure.kind,
        error: failure.message,
      });
      if (failure.fatal || failure.kind === "aborted") break;
    }
  }
  const sorted = latencies.toSorted((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
  return {
    strategy,
    decider: kind,
    passed: rows.filter((row) => row.ok).length,
    total: fixtures.length,
    latency_ms: { p50: pct(0.5), p95: pct(0.95) },
    cost_usd: cost,
    rows,
  };
};
