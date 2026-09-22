import { afterEach, expect, spyOn, test } from "bun:test";

import type { EvaluateAdapter } from "@tanstack/ai";

import {
  booleanAnswer,
  choiceAnswer,
  DecideFailure,
  jevEvaluator,
  memoryMeter,
  scoreAnswer,
} from "./jev";
import { localAdapter } from "./mock";
import { runFixtures, runSmoke } from "./offline";

const rate = { input: 0.042e-6, output: 0, source: "test" };
type DoEvaluate = EvaluateAdapter["evaluate"];
const model = localAdapter;
const initialKey = process.env["AI_GATEWAY_API_KEY"];
const initialZdr = process.env["ROBO_JEV_ZDR"];
afterEach(() => {
  if (initialKey === undefined) delete process.env["AI_GATEWAY_API_KEY"];
  else process.env["AI_GATEWAY_API_KEY"] = initialKey;
  if (initialZdr === undefined) delete process.env["ROBO_JEV_ZDR"];
  else process.env["ROBO_JEV_ZDR"] = initialZdr;
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
      adapter: model(doEvaluate),
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
        confidence: 1,
        probabilities: { a: 0.9, b: 0.1 },
      },
    },
    usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 },
    model: "mock-jev",
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
  const task = {
    name: "control-smoke" as const,
    description: "",
    stages: [item.goal],
    explore: [],
    start: item.obs.measured,
  };
  const { stageTracker } = await import("./tasks");
  const state = decisionState({
    obs: item.obs,
    task,
    view: stageTracker(task, defaultLimits).advance(item.obs, []),
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
    {
      type: "choice" as const,
      choice: "shoulder_pan+90",
      confidence: 1,
      probabilities: { "shoulder_pan+90": 1 },
    },
    {
      type: "choice" as const,
      choice: "stop",
      confidence: 1,
      probabilities: { stop: 0.4, wait: 0.2 },
    },
  ]) {
    const evaluate = jevEvaluator({
      adapter: model(() =>
        Promise.resolve({
          answers: { nextAction: bad },
          usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
          model: "mock-jev",
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
    expect(kind).toBe("invalid_answer");
  }
});

test("the real gateway adapter pins the contract and maps all three answer types", async () => {
  process.env["AI_GATEWAY_API_KEY"] = "test-gateway-key";
  process.env["ROBO_JEV_ZDR"] = "1";
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (
        url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) => {
        expect(String(url)).toBe(
          "https://ai-gateway.vercel.sh/v4/ai/evaluation-model"
        );
        expect(init?.method).toBe("POST");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer test-gateway-key");
        expect(headers.get("ai-model-id")).toBe("typesafe-ai/jev");
        expect(headers.get("ai-evaluation-model-specification-version")).toBe(
          "4"
        );
        expect(headers.get("ai-gateway-protocol-version")).toBe("0.0.1");
        expect(headers.get("ai-gateway-auth-method")).toBe("api-key");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const body = JSON.parse(String(init?.body));
        expect(body.providerOptions.gateway).toEqual({
          only: ["typesafe-ai"],
          zeroDataRetention: true,
        });
        expect(body.model).toBe("typesafe-ai/jev");
        expect(body.state).toEqual({ fixture: true });
        expect(body.questions.safe.type).toBe("boolean");
        expect(body.questions.next.criteria).toEqual({ a: "A", b: "B" });
        return Promise.resolve(
          Response.json({
            model: "typesafe-ai/jev",
            answers: {
              next: {
                type: "choice",
                choice: "a",
                probabilities: { a: 0.9, b: 0.1 },
              },
              safe: { type: "boolean", probability: 0.8 },
              risk: {
                type: "score",
                score: 0.2,
                probabilities: { "0": 0.8, "1": 0.2 },
                legend: { "0": "low", "1": "high" },
              },
            },
            usage: { inputTokens: 123, outputTokens: 7 },
            providerMetadata: { typesafe: { confidence: { next: 0.7 } } },
          })
        );
      },
      { preconnect: fetch.preconnect }
    )
  );
  try {
    const meter = memoryMeter(rate, 1);
    const result = await jevEvaluator({ meter })({
      state: { fixture: true },
      questions: {
        ...question,
        safe: { type: "noul", instructions: "Is it safe?" },
        risk: {
          type: "score",
          instructions: "How risky?",
          criteria: ["low", "high"],
        },
      },
      signal: new AbortController().signal,
    });
    expect(choiceAnswer(result.answers["next"], ["a", "b"]).value).toBe("a");
    expect(choiceAnswer(result.answers["next"], ["a", "b"]).confidence).toBe(
      0.7
    );
    expect(booleanAnswer(result.answers["safe"])).toBe(0.8);
    expect(scoreAnswer(result.answers["risk"], 2)).toBe(0.2);
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 7 });
    expect(result.cost_usd).toBe(123 * rate.input);
    expect(meter.summary()).toEqual({
      calls: 1,
      usd: 123 * rate.input,
      limit_usd: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    fetchMock.mockRestore();
  }
});

test("gateway HTTP errors keep their failure kinds and are never retried", async () => {
  process.env["AI_GATEWAY_API_KEY"] = "test-gateway-key";
  for (const [status, kind] of [
    [401, "authentication"],
    [402, "billing"],
    [403, "model_access"],
    [404, "model_access"],
    [429, "rate_limit"],
    [500, "provider"],
  ] as const) {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("denied", { status })
    );
    try {
      expect(
        jevEvaluator({ meter: memoryMeter(rate, 1) })({
          state: {},
          questions: question,
          signal: new AbortController().signal,
        })
      ).rejects.toMatchObject({ kind });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  }
});

test("missing and malformed gateway answers are invalid answers", async () => {
  process.env["AI_GATEWAY_API_KEY"] = "test-gateway-key";
  for (const answers of [
    {},
    { next: { type: "choice", choice: "a" } },
    { next: { type: "boolean", probability: 0.9 } },
    { next: { type: "choice" } },
  ]) {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ answers })
    );
    try {
      expect(
        jevEvaluator({ meter: memoryMeter(rate, 1) })({
          state: {},
          questions: question,
          signal: new AbortController().signal,
        })
      ).rejects.toMatchObject({ kind: "invalid_answer" });
    } finally {
      fetchMock.mockRestore();
    }
  }
});

test("caller cancellation aborts the adapter and a pre-aborted call spends nothing", async () => {
  const abort = new AbortController();
  const entered = Promise.withResolvers<null>();
  let wasAborted = false;
  const adapter = localAdapter(({ abortSignal }) => {
    entered.resolve(null);
    const pending = Promise.withResolvers<never>();
    abortSignal?.addEventListener("abort", () => {
      wasAborted = true;
      pending.reject(abortSignal.reason);
    });
    return pending.promise;
  });
  const meter = memoryMeter(rate, 1);
  const evaluate = jevEvaluator({ meter, adapter });
  const pending = evaluate({
    state: {},
    questions: question,
    signal: abort.signal,
  });
  await entered.promise;
  abort.abort();
  expect(pending).rejects.toMatchObject({ kind: "aborted" });
  expect(wasAborted).toBe(true);
  expect(
    evaluate({ state: {}, questions: question, signal: abort.signal })
  ).rejects.toMatchObject({ kind: "aborted" });
  expect(meter.summary().calls).toBe(1);
});

test("offline fixtures and the mock smoke never fetch", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("network forbidden")
  );
  try {
    const smoke = await runSmoke("mock");
    expect(smoke.status).toBe("passed");
    expect(smoke.tanstack_ai).toBe("0.58.0");
    for (const strategy of ["rules", "choice", "parallel", "critic"] as const) {
      const result = await runFixtures(
        strategy,
        "mock",
        new AbortController().signal
      );
      expect(result.passed).toBe(result.total);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    fetchMock.mockRestore();
  }
});
