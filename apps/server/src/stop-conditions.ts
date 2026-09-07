// Loop guards beyond a raw step cap (ported from invok's harness): a model
// stuck re-issuing the identical tool call burns steps without progress.
//
// Two signatures, two thresholds. A CALL signature (tool + input) counts the
// repeats the harness bar warns about at DOOM_LOOP_NUDGE. A STEP signature
// (tool + input + result) is what stops the turn at DOOM_LOOP_STOP: a capture
// that keeps returning a new frame is a poll making progress, not a loop, and
// pairing calls with their results is what tells the two apart.

/** JSON for anything; "" when it cannot be serialized (circular, undefined).
 *  Callers hash or display the result, so "nothing" beats a throw. */
const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

interface ToolCallLike {
  readonly toolName: string;
  readonly input: unknown;
}
interface ToolResultLike {
  readonly toolName: string;
  readonly output: unknown;
}

/** The slice of the AI SDK's `StepResult` these guards read. Kept narrow so
 *  a test can build steps by hand and the bar can be fed the same shape. */
interface StepLike {
  readonly toolCalls?: readonly ToolCallLike[];
  readonly toolResults?: readonly ToolResultLike[];
}

/** A tool result can be tens of kilobytes; the signature carries a hash of
 *  it, not the bytes. */
const hashOf = (value: unknown): string =>
  Bun.hash(safeJson(value)).toString(36);

/** What the model asked for: every tool call of the step, order-independent. */
const callSignature = (step: StepLike): string =>
  (step.toolCalls ?? [])
    .map((call) => `${call.toolName}:${safeJson(call.input)}`)
    .toSorted()
    .join("|");

/** What the model got back, order-independent. */
const resultSignature = (step: StepLike): string =>
  (step.toolResults ?? [])
    .map((result) => `${result.toolName}=>${hashOf(result.output)}`)
    .toSorted()
    .join("|");

/** What the model asked for AND what it got back. */
export const stepSignature = (step: StepLike): string => {
  const calls = callSignature(step);
  if (calls === "") {
    return "";
  }
  return `${calls}#${resultSignature(step)}`;
};

/** At this many identical calls in a row the harness bar tells the model to
 *  change strategy. */
export const DOOM_LOOP_NUDGE = 3;

/** At this many identical call+result steps in a row the turn ends. */
export const DOOM_LOOP_STOP = 5;

/** True when the last DOOM_LOOP_STOP steps all made the same (non-empty)
 *  tool calls and got the same results back. */
export const isDoomLoop = (steps: readonly StepLike[]): boolean => {
  if (steps.length < DOOM_LOOP_STOP) {
    return false;
  }
  const recent = steps.slice(-DOOM_LOOP_STOP).map(stepSignature);
  const first = recent[0];
  return (
    first !== "" && first !== undefined && recent.every((sig) => sig === first)
  );
};

export interface TrailingRepeat {
  readonly count: number;
  readonly calls: readonly ToolCallLike[];
  readonly lastOutput: unknown;
}

/** The run of consecutive steps, ending at the last one, that made the same
 *  tool calls as it (results ignored — this is what the model keeps ASKING).
 *  `null` when the last step made no tool call. */
export const trailingRepeat = (
  steps: readonly StepLike[]
): TrailingRepeat | null => {
  const last = steps.at(-1);
  if (last === undefined) {
    return null;
  }
  const signature = callSignature(last);
  if (signature === "") {
    return null;
  }
  let count = 0;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step === undefined || callSignature(step) !== signature) {
      break;
    }
    count += 1;
  }
  return {
    count,
    calls: last.toolCalls ?? [],
    // The first result of the LAST repeated step (hence the name) — a
    // repeat of several calls quotes one of them, and the bar says which.
    lastOutput: last.toolResults?.[0]?.output,
  };
};

/** StopCondition for streamText: halt a model that repeats itself. */
export const noDoomLoop = ({
  steps,
}: {
  steps: readonly StepLike[];
}): boolean => isDoomLoop(steps);

// Two shapes the pair above cannot see. `isDoomLoop` needs five IDENTICAL
// steps in a row, and `trailingRepeat` needs identical arguments, so a model
// that alternates between two states, or that keeps varying its arguments and
// keeps getting the same answer, runs to the step cap unremarked.

/** How many trailing steps the cycle guard looks at. Wider than the doom
 *  loop's run because it is counting a pattern, not a repeat. */
export const CYCLE_WINDOW = 6;

/** At most this many distinct steps in that window for it to be a cycle.
 *  Two is A,B,A,B,A,B — the shape worth catching. */
const CYCLE_DISTINCT_MAX = 2;

/**
 * True when the last `CYCLE_WINDOW` steps cycle between at most
 * `CYCLE_DISTINCT_MAX` distinct states, each recurring.
 *
 * Generalises `isDoomLoop`, which is the one-distinct-state case. It inherits
 * the same safety property: the signature carries results, so a step that
 * learned anything is a new signature and breaks the window.
 */
export const isCycleLoop = (steps: readonly StepLike[]): boolean => {
  if (steps.length < CYCLE_WINDOW) {
    return false;
  }
  const recent = steps.slice(-CYCLE_WINDOW).map(stepSignature);
  if (recent.some((sig) => sig === "")) {
    return false;
  }
  const seen = new Map<string, number>();
  for (const sig of recent) {
    seen.set(sig, (seen.get(sig) ?? 0) + 1);
  }
  return (
    seen.size <= CYCLE_DISTINCT_MAX &&
    [...seen.values()].every((count) => count > 1)
  );
};

/** StopCondition for streamText: halt a model going in circles. */
export const noCycleLoop = ({
  steps,
}: {
  steps: readonly StepLike[];
}): boolean => isCycleLoop(steps);

export interface ResultChurn {
  readonly count: number;
  readonly distinctCalls: number;
  readonly output: unknown;
}

/** Churn is a nudge, never a stop, and it starts one step later than the
 *  repeat nudge: "same answer" is real evidence when the model is searching
 *  and no evidence at all when each call is doing work. The model is told
 *  what was observed and left to judge. */
export const CHURN_NUDGE = 4;

/**
 * The run of trailing steps that all got the SAME result while asking
 * something DIFFERENT — repeated captures of a stale frame, a move retried
 * with new arguments that fails the same way.
 *
 * `null` when the last step made no call, produced no result, or when the
 * calls were identical too: that run is `trailingRepeat`'s to report.
 */
export const resultChurn = (steps: readonly StepLike[]): ResultChurn | null => {
  const last = steps.at(-1);
  if (last === undefined || callSignature(last) === "") {
    return null;
  }
  const results = resultSignature(last);
  if (results === "") {
    return null;
  }
  const calls = new Set<string>();
  let count = 0;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step === undefined || resultSignature(step) !== results) {
      break;
    }
    calls.add(callSignature(step));
    count += 1;
  }
  return calls.size < 2
    ? null
    : {
        count,
        distinctCalls: calls.size,
        output: last.toolResults?.[0]?.output,
      };
};
