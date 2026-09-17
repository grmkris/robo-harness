import { expect, test } from "bun:test";

import type { Experimental_EvaluationModelV4 } from "@ai-sdk/provider";
import { Experimental_EvaluationMockModelV4 } from "ai/test";

import { DecideFailure, jevEvaluator, memoryMeter } from "./jev";
import { runFixtures } from "./offline";

const rate = { input: 0.042e-6, output: 0, source: "test" };
type DoEvaluate = Experimental_EvaluationModelV4["doEvaluate"];
const model = (doEvaluate: DoEvaluate) =>
  new Experimental_EvaluationMockModelV4({
    provider: "mock",
    modelId: "mock-jev",
    supportedQuestionTypes: ["choice", "boolean"],
    doEvaluate,
  });
const question = {
  next: {
    type: "choice" as const,
    instructions: "pick",
    criteria: { a: "A", b: "B" },
  },
};
const failureOf = async (
  doEvaluate: DoEvaluate,
  options: { timeoutMs?: number; limit?: number } = {}
) => {
  try {
    await jevEvaluator({
      model: model(doEvaluate),
      meter: memoryMeter(rate, options.limit ?? 1),
      timeoutMs: options.timeoutMs ?? 1000,
    })({
      state: { x: 1 },
      questions: question,
      signal: new AbortController().signal,
    });
  } catch (error) {
    return error instanceof DecideFailure
      ? error.kind
      : `unexpected: ${String(error)}`;
  }
  return "no failure";
};
const answer = (choice: string) =>
  Promise.resolve({
    answers: {
      next: {
        type: "choice" as const,
        choice,
        probabilities: { a: 0.9, b: 0.1 },
      },
    },
    usage: { inputTokens: 100, outputTokens: 0 },
    warnings: [],
  });

test("a slow model is cut off at the deadline", async () => {
  const started = performance.now();
  const kind = await failureOf(
    ({ abortSignal }) => {
      const pending = Promise.withResolvers<never>();
      abortSignal?.addEventListener("abort", () =>
        pending.reject(abortSignal.reason)
      );
      return pending.promise;
    },
    { timeoutMs: 100 }
  );
  expect(kind).toBe("timeout");
  expect(performance.now() - started).toBeLessThan(1000);
});

test("gateway failures are reported distinctly", async () => {
  const thrown = (fields: Record<string, unknown>) => () =>
    Promise.reject(
      Object.assign(new Error(String(fields["message"] ?? "x")), fields)
    );
  expect(
    await failureOf(
      thrown({
        name: "GatewayRateLimitError",
        type: "rate_limit_exceeded",
        statusCode: 429,
      })
    )
  ).toBe("rate_limit");
  expect(
    await failureOf(
      thrown({ statusCode: 402, message: "Insufficient credits" })
    )
  ).toBe("billing");
  expect(
    await failureOf(thrown({ type: "model_not_found", statusCode: 404 }))
  ).toBe("model_access");
  const previous = process.env["AI_GATEWAY_API_KEY"];
  process.env["AI_GATEWAY_API_KEY"] = "test-not-a-key";
  expect(
    await failureOf(thrown({ type: "authentication_error", statusCode: 401 }))
  ).toBe("authentication");
  if (previous === undefined) delete process.env["AI_GATEWAY_API_KEY"];
  else process.env["AI_GATEWAY_API_KEY"] = previous;
});

test("the budget refuses a call before any request", async () => {
  let called = false;
  const kind = await failureOf(
    () => {
      called = true;
      return answer("a");
    },
    { limit: 0 }
  );
  expect(kind).toBe("budget");
  expect(called).toBe(false);
});

test("the live Gateway path is never used without a key", async () => {
  const previous = process.env["AI_GATEWAY_API_KEY"];
  delete process.env["AI_GATEWAY_API_KEY"];
  let kind = "no failure";
  try {
    await jevEvaluator({ meter: memoryMeter(rate, 1) })({
      state: {},
      questions: question,
      signal: new AbortController().signal,
    });
  } catch (error) {
    kind = error instanceof DecideFailure ? error.kind : "unexpected";
  }
  if (previous !== undefined) process.env["AI_GATEWAY_API_KEY"] = previous;
  expect(kind).toBe("missing_credentials");
});

test("every strategy chooses acceptably on the offline fixtures through the SDK mock", async () => {
  for (const strategy of ["rules", "choice", "parallel", "critic"] as const) {
    const result = await runFixtures(
      strategy,
      "mock",
      new AbortController().signal
    );
    expect({ strategy, failed: result.rows.filter((row) => !row.ok) }).toEqual({
      strategy,
      failed: [],
    });
  }
});

test("an answer outside the offered actions never becomes an action", async () => {
  const { choiceDecider } = await import("./strategies");
  const { fixtures } = await import("./fixtures");
  const { candidates, defaultLimits } = await import("./candidates");
  const { decisionState } = await import("./state");
  const item = fixtures[0];
  if (!item) throw new Error("fixture missing");
  const offered = candidates(
    item.obs,
    { goal: item.goal, explore: [] },
    defaultLimits
  );
  const state = decisionState({
    obs: item.obs,
    task: {
      name: "control-smoke",
      description: "",
      stages: [item.goal],
      explore: [],
      start: item.obs.measured,
    },
    stage: 0,
    limits: defaultLimits,
    previous: item.previous,
    progress: {
      step: 1,
      max_steps: 1,
      executed: 0,
      completed: 0,
      consecutive_failures: 0,
    },
  });
  for (const bad of [
    { type: "choice" as const, choice: "shoulder_pan+90" },
    {
      type: "choice" as const,
      choice: "stop",
      probabilities: { stop: 0.4, wait: 0.2 },
    },
  ]) {
    const evaluate = jevEvaluator({
      model: model(() =>
        Promise.resolve({
          answers: { nextAction: bad },
          usage: { inputTokens: 1, outputTokens: 0 },
          warnings: [],
        })
      ),
      meter: memoryMeter(rate, 1),
    });
    let kind = "no failure";
    try {
      await choiceDecider(evaluate).decide({
        state,
        offered,
        signal: new AbortController().signal,
      });
    } catch (error) {
      kind = error instanceof DecideFailure ? error.kind : "unexpected";
    }
    expect(["invalid_answer", "provider"]).toContain(kind);
  }
});
