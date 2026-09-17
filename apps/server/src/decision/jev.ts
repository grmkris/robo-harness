import type { Experimental_EvaluationModelV4 } from "@ai-sdk/provider";
import { experimental_evaluate as evaluate } from "ai";
import type { Experimental_EvaluationQuestion } from "ai";
import { Effect } from "effect";

const JEV_MODEL = "typesafe-ai/jev";

const FailureKinds = [
  "missing_credentials",
  "authentication",
  "billing",
  "model_access",
  "rate_limit",
  "timeout",
  "aborted",
  "invalid_answer",
  "budget",
  "provider",
] as const;
export type FailureKind = (typeof FailureKinds)[number];

const fatalKinds = new Set<FailureKind>([
  "missing_credentials",
  "authentication",
  "billing",
  "model_access",
  "budget",
]);

export class DecideFailure extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.name = "DecideFailure";
    this.kind = kind;
  }
  /** Failures no retry within the same run can fix. */
  get fatal() {
    return fatalKinds.has(this.kind);
  }
}

export interface Rate {
  /** USD per input token. */
  readonly input: number;
  /** USD per output token. */
  readonly output: number;
  readonly source: string;
}

const fallbackRate: Rate = {
  input: 0.042e-6,
  output: 0,
  source: "fallback: Gateway catalog 2026-09-17",
};

interface CatalogModel {
  readonly id?: unknown;
  readonly pricing?: { readonly input?: unknown; readonly output?: unknown };
}

/** Current Jev rates from the public Gateway catalog (no credentials). */
export const jevRate = async (timeoutMs = 4000): Promise<Rate> => {
  try {
    const response = await fetch("https://ai-gateway.vercel.sh/v1/models", {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json()) as { data?: readonly CatalogModel[] };
    const model = body.data?.find((entry) => entry.id === JEV_MODEL);
    const input = Number(model?.pricing?.input);
    const output = Number(model?.pricing?.output ?? 0);
    if (Number.isFinite(input) && Number.isFinite(output)) {
      return { input, output, source: "gateway-catalog" };
    }
  } catch {
    // The fallback is labelled as such in every log line that uses it.
  }
  return fallbackRate;
};

/** Spend accounting shared by every Jev call in the process. */
export interface SpendMeter {
  readonly rate: Rate;
  /** Throws a budget failure when another call could overrun the cap. */
  readonly reserve: () => void;
  readonly record: (usd: number) => void;
  readonly summary: () => { calls: number; usd: number; limit_usd: number };
}

export const memoryMeter = (rate: Rate, limitUsd: number): SpendMeter => {
  let calls = 0;
  let usd = 0;
  return {
    rate,
    reserve: () => {
      if (usd + 4000 * rate.input > limitUsd) {
        throw new DecideFailure(
          "budget",
          `Jev budget exhausted ($${usd.toFixed(6)} of $${limitUsd})`
        );
      }
      calls += 1;
    },
    record: (cost) => {
      usd += cost;
    },
    summary: () => ({ calls, usd, limit_usd: limitUsd }),
  };
};

interface ErrorFields {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly statusCode?: unknown;
  readonly message?: unknown;
}

/** Map AI SDK / Gateway errors to distinct kinds, without request details. */
const classify = (error: unknown): DecideFailure => {
  if (error instanceof DecideFailure) {
    return error;
  }
  const fields: ErrorFields =
    typeof error === "object" && error !== null ? error : {};
  const name = typeof fields.name === "string" ? fields.name : "";
  const type = typeof fields.type === "string" ? fields.type : "";
  const status =
    typeof fields.statusCode === "number" ? fields.statusCode : undefined;
  const message =
    (typeof fields.message === "string" ? fields.message : String(error))
      .split("\n")[0]
      ?.slice(0, 240) ?? "";
  // Typed Gateway errors first: an authentication message also names the variable.
  if (type === "authentication_error" || status === 401) {
    return new DecideFailure(
      process.env["AI_GATEWAY_API_KEY"]
        ? "authentication"
        : "missing_credentials",
      message
    );
  }
  if (name === "LoadAPIKeyError") {
    return new DecideFailure(
      "missing_credentials",
      "AI_GATEWAY_API_KEY is not set"
    );
  }
  if (
    status === 402 ||
    /insufficient|credit|payment|billing|funds|free tier|upgrade your plan/iu.test(
      `${type} ${message}`
    )
  ) {
    return new DecideFailure("billing", message);
  }
  if (
    type === "model_not_found" ||
    type === "forbidden" ||
    status === 403 ||
    status === 404
  ) {
    return new DecideFailure("model_access", message);
  }
  if (type === "rate_limit_exceeded" || status === 429) {
    return new DecideFailure("rate_limit", message);
  }
  if (name === "TimeoutError" || name === "TimeoutException") {
    return new DecideFailure("timeout", "request deadline exceeded");
  }
  return new DecideFailure("provider", `${name || "Error"}: ${message}`);
};

type Questions = Readonly<Record<string, Experimental_EvaluationQuestion>>;

interface EvaluateRequest {
  readonly state: unknown;
  readonly questions: Questions;
  readonly signal: AbortSignal;
}

export interface Usage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

interface EvaluateOutcome {
  readonly answers: Readonly<Record<string, unknown>>;
  readonly usage: Usage;
  readonly cost_usd: number;
  readonly latency_ms: number;
  readonly model: string;
}

/**
 * Zero data retention is a Pro/Enterprise Gateway feature; on Hobby the request
 * is refused. The state sent is joint telemetry and pixel offsets, never
 * images, so it is opt-in via ROBO_JEV_ZDR=1.
 */
const zeroDataRetention = () => process.env["ROBO_JEV_ZDR"] === "1";

export type Evaluator = (request: EvaluateRequest) => Promise<EvaluateOutcome>;

export interface EvaluatorOptions {
  /** A model instance (tests, mocks) or the Gateway model ID. */
  readonly model?: Experimental_EvaluationModelV4 | string;
  readonly timeoutMs?: number;
  readonly meter: SpendMeter;
}

/**
 * One evaluation request with a hard deadline. The deadline interrupts the
 * request and aborts its signal, so a late answer can never be used.
 */
export const jevEvaluator =
  (options: EvaluatorOptions): Evaluator =>
  async (request) => {
    const model = options.model ?? JEV_MODEL;
    if (typeof model === "string" && !process.env["AI_GATEWAY_API_KEY"]) {
      throw new DecideFailure(
        "missing_credentials",
        "AI_GATEWAY_API_KEY is not set"
      );
    }
    options.meter.reserve();
    const timeoutMs = options.timeoutMs ?? 8000;
    const started = performance.now();
    const call = Effect.tryPromise({
      try: (signal) =>
        evaluate({
          model,
          state: request.state as never,
          questions: request.questions,
          maxRetries: 0,
          abortSignal: AbortSignal.any([signal, request.signal]),
          providerOptions: {
            gateway: { zeroDataRetention: zeroDataRetention() },
          },
        }),
      catch: (error) => error,
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            new DecideFailure("timeout", `no answer within ${timeoutMs} ms`)
          ),
      })
    );
    try {
      const result = await Effect.runPromise(call, { signal: request.signal });
      const inputTokens = result.usage.inputTokens ?? null;
      const outputTokens = result.usage.outputTokens ?? null;
      const cost =
        (inputTokens ?? 0) * options.meter.rate.input +
        (outputTokens ?? 0) * options.meter.rate.output;
      options.meter.record(cost);
      return {
        answers: result.answers,
        usage: { inputTokens, outputTokens },
        cost_usd: cost,
        latency_ms: Math.round(performance.now() - started),
        model: result.response.modelId,
      };
    } catch (error) {
      if (request.signal.aborted) {
        throw new DecideFailure("aborted", "run cancelled");
      }
      throw classify(error);
    }
  };

interface AnswerFields {
  readonly type?: unknown;
  readonly choice?: unknown;
  readonly probability?: unknown;
  readonly probabilities?: unknown;
}

const fieldsOf = (answer: unknown): AnswerFields =>
  typeof answer === "object" && answer !== null ? answer : {};

const isProbability = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

export interface ChoiceAnswer {
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>> | null;
}

/** Choice answer: an offered option and, when present, a normalised distribution. */
export const choiceAnswer = (
  answer: unknown,
  options: readonly string[]
): ChoiceAnswer => {
  const fields = fieldsOf(answer);
  if (
    fields.type !== "choice" ||
    typeof fields.choice !== "string" ||
    !options.includes(fields.choice)
  ) {
    throw new DecideFailure(
      "invalid_answer",
      `choice ${JSON.stringify(fields.choice)} is not an offered option`
    );
  }
  if (fields.probabilities === undefined) {
    return { choice: fields.choice, probabilities: null };
  }
  if (
    typeof fields.probabilities !== "object" ||
    fields.probabilities === null
  ) {
    throw new DecideFailure("invalid_answer", "probabilities is not an object");
  }
  const probabilities: Record<string, number> = {};
  let sum = 0;
  for (const [option, value] of Object.entries(fields.probabilities)) {
    if (!options.includes(option) || !isProbability(value)) {
      throw new DecideFailure(
        "invalid_answer",
        `bad probability for ${option}`
      );
    }
    probabilities[option] = value;
    sum += value;
  }
  if (Math.abs(sum - 1) > 0.02) {
    throw new DecideFailure("invalid_answer", `probabilities sum to ${sum}`);
  }
  return { choice: fields.choice, probabilities };
};

/** Boolean answer: P(true) in [0, 1]. */
export const booleanAnswer = (answer: unknown): number => {
  const fields = fieldsOf(answer);
  if (fields.type !== "boolean" || !isProbability(fields.probability)) {
    throw new DecideFailure(
      "invalid_answer",
      "boolean answer lacks a valid probability"
    );
  }
  return fields.probability;
};
