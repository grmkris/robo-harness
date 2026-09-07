import { expect, test } from "bun:test";

import {
  CHURN_NUDGE,
  CYCLE_WINDOW,
  DOOM_LOOP_NUDGE,
  DOOM_LOOP_STOP,
  isCycleLoop,
  isDoomLoop,
  resultChurn,
  stepSignature,
  trailingRepeat,
} from "./stop-conditions";

const capture = { toolName: "capture", input: { camera: "workspace" } };
const observe = { toolName: "observe", input: {} };
const OK = { ok: true };

/** A step that made `calls` and got `output` back for each. */
const step = (
  calls: { toolName: string; input: unknown }[],
  output: unknown = OK
) => ({
  toolCalls: calls,
  toolResults: calls.map((call) => ({ toolName: call.toolName, output })),
});

const repeat = <T>(value: T, times: number): T[] =>
  Array.from({ length: times }, () => value);

test("identical call and result, DOOM_LOOP_STOP times in a row, trips the guard — one short, or broken by another call, does not", () => {
  expect(isDoomLoop(repeat(step([capture]), DOOM_LOOP_STOP))).toBe(true);
  expect(isDoomLoop(repeat(step([capture]), DOOM_LOOP_STOP - 1))).toBe(false);
  expect(
    isDoomLoop([step([observe]), ...repeat(step([capture]), DOOM_LOOP_STOP)])
  ).toBe(true);
});

test("the same call with a different result each time is progress, not a loop", () => {
  const steps = Array.from({ length: DOOM_LOOP_STOP }, (_, i) =>
    step([capture], { frame: `frame ${i}` })
  );
  expect(isDoomLoop(steps)).toBe(false);
});

test("DOOM_LOOP_NUDGE identical steps do not stop, but the bar sees the repeat", () => {
  const steps = repeat(step([capture]), DOOM_LOOP_NUDGE);
  expect(isDoomLoop(steps)).toBe(false);
  expect(trailingRepeat(steps)?.count).toBe(DOOM_LOOP_NUDGE);
});

test("varied calls do not trip it", () => {
  expect(isDoomLoop([...repeat(step([capture]), 4), step([observe])])).toBe(
    false
  );
  expect(
    isDoomLoop([
      ...repeat(step([capture]), 4),
      step([{ ...capture, input: { camera: "wrist" } }]),
    ])
  ).toBe(false);
});

test("text-only steps never trip it, and have no repeat", () => {
  const text = { toolCalls: [], toolResults: [] };
  expect(isDoomLoop(repeat(text, DOOM_LOOP_STOP))).toBe(false);
  expect(trailingRepeat(repeat(text, 2))).toBeNull();
  expect(trailingRepeat([])).toBeNull();
});

test("trailingRepeat counts back from the last step only and carries the last output", () => {
  const steps = [
    ...repeat(step([capture]), 3),
    step([observe], { frame: "x" }),
    ...repeat(step([capture]), 2),
  ];
  const found = trailingRepeat(steps);
  expect(found?.count).toBe(2);
  expect(found?.calls).toEqual([capture]);
  expect(trailingRepeat(steps.slice(0, 4))).toEqual({
    count: 1,
    calls: [observe],
    lastOutput: { frame: "x" },
  });
});

test("the signature is stable across the two result shapes the SDK produces", () => {
  const json = step([capture], { type: "json", value: { ok: true } });
  const text = step([capture], { type: "text", value: "ok" });
  expect(stepSignature(json)).toBe(
    stepSignature(step([capture], { type: "json", value: { ok: true } }))
  );
  expect(stepSignature(json)).not.toBe(stepSignature(text));
  expect(stepSignature({ toolCalls: [] })).toBe("");
});

/** A move to a different target each time. */
const varied = (n: number) => ({
  toolName: "move",
  input: { request_id: `r-${String(n)}`, target: { gripper: n } },
});

const cycle = <T>(values: T[], length: number): T[] =>
  Array.from({ length }, (_, i) => values[i % values.length] as T);

test("alternating between two states trips the cycle guard; the doom loop cannot see it", () => {
  const steps = cycle([step([capture]), step([observe])], CYCLE_WINDOW);
  expect(isCycleLoop(steps)).toBe(true);
  // The shape this exists for: five in a row are never identical.
  expect(isDoomLoop(steps)).toBe(false);
});

test("a cycle one step short of the window is not yet a cycle", () => {
  expect(
    isCycleLoop(cycle([step([capture]), step([observe])], CYCLE_WINDOW - 1))
  ).toBe(false);
});

test("distinct work is not a cycle, however long the window", () => {
  const moves = Array.from({ length: CYCLE_WINDOW }, (_, i) =>
    step([{ toolName: "move", input: { request_id: `w-${String(i)}` } }])
  );
  expect(isCycleLoop(moves)).toBe(false);
});

test("three states in the window is exploring, not circling", () => {
  const steps = cycle(
    [step([capture]), step([observe]), step([varied(1)])],
    CYCLE_WINDOW
  );
  expect(isCycleLoop(steps)).toBe(false);
});

test("a poll returning something new each time never cycles", () => {
  const steps = Array.from({ length: CYCLE_WINDOW }, (_, i) =>
    step([capture], { frame: `frame ${String(i)}` })
  );
  expect(isCycleLoop(steps)).toBe(false);
});

test("steps that called nothing are not a cycle", () => {
  expect(isCycleLoop(repeat({ toolCalls: [] }, CYCLE_WINDOW))).toBe(false);
});

test("different arguments, same answer, is churn", () => {
  const steps = Array.from({ length: CHURN_NUDGE }, (_, i) =>
    step([varied(i)], { status: "failed" })
  );
  const found = resultChurn(steps);
  expect(found?.count).toBe(CHURN_NUDGE);
  expect(found?.distinctCalls).toBe(CHURN_NUDGE);
  expect(found?.output).toEqual({ status: "failed" });
});

test("churn stops counting at the step that got a different answer", () => {
  const steps = [
    step([varied(0)], { status: "completed" }),
    step([varied(1)], { status: "failed" }),
    step([varied(2)], { status: "failed" }),
  ];
  expect(resultChurn(steps)?.count).toBe(2);
});

test("identical calls are the repeat guard's to report, not churn's", () => {
  expect(resultChurn(repeat(step([capture]), CHURN_NUDGE))).toBeNull();
});

test("churn needs a call and a result to compare", () => {
  expect(resultChurn([])).toBeNull();
  expect(resultChurn([{ toolCalls: [] }])).toBeNull();
  expect(resultChurn([{ toolCalls: [capture] }])).toBeNull();
});
