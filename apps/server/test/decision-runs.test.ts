import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { startHarness, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

const idle = async () =>
  h.until(async () => {
    const response = await h.request("/api/decision");
    const body = (await response.json()) as { runs: unknown[] };
    return body.runs.length === 0;
  }, 60_000);

const lines = (path: string) =>
  readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

test("the offline smoke passes through the SDK mock and a live smoke without a key is blocked", async () => {
  const mock = await (
    await h.request("/api/decision/smoke", { decider: "mock" })
  ).json();
  expect(mock.status).toBe("passed");
  expect(mock.answer.value).toBe("reobserve");
  // The harness gives the app no Gateway key, so this half asserts the
  // missing-credential path without calling out to a live model.
  const live = await (
    await h.request("/api/decision/smoke", { decider: "jev" })
  ).json();
  expect(live.status).toBe("blocked");
  expect(live.failure).toBe("missing_credentials");
}, 90_000);

test("observe previews candidates without motion", async () => {
  const response = await h.request("/api/decision/observe", {});
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.backend).toBe("mock");
  expect(body.candidates).toContain("gripper+1.8");
  expect(body.motor_writes).toBe(0);
}, 90_000);

test("a dry run on mock hardware logs recommendations and moves nothing", async () => {
  const before = (await h.status()).observation.measured;
  const started = await (
    await h.request("/api/decision/runs", {
      decider: "mock",
      strategy: "parallel",
      max_steps: 3,
    })
  ).json();
  await idle();
  const log = lines(started.log_path);
  expect(log.at(-1)?.["event"]).toBe("finished");
  expect(
    log.filter((line) => line["outcome"] === "not executed (dry-run)").length
  ).toBe(3);
  expect((await h.status()).observation.measured).toEqual(before);
}, 90_000);

test("a mock-backed execute run reaches every stage through the shared executor", async () => {
  const started = await (
    await h.request("/api/decision/runs", {
      decider: "mock",
      strategy: "choice",
      mode: "execute",
      max_steps: 20,
      max_seconds: 60,
    })
  ).json();
  expect(started.run_id).toBeString();
  await idle();
  const log = lines(started.log_path);
  const finished = log.at(-1) ?? {};
  expect(finished["event"]).toBe("finished");
  expect(finished["end_reason"]).toBe("done");
  expect(finished["stages_reached"]).toBe(3);
  const completed = log.filter(
    (line) => line["event"] === "step" && line["outcome"] === "completed"
  );
  expect(completed.length).toBeGreaterThanOrEqual(4);
  const status = await h.status();
  expect(status.observation.operator).toBeNull();
}, 90_000);

test("chat cannot start while a decision run is active, and a second run is refused", async () => {
  const started = await (
    await h.request("/api/decision/runs", {
      decider: "mock",
      strategy: "rules",
      max_steps: 20,
      max_seconds: 30,
    })
  ).json();
  const second = await h.request("/api/decision/runs", { decider: "mock" });
  expect(second.status).toBe(409);
  const chat = await h.request("/api/chat", {
    provider: "alibaba",
    text: "observe",
  });
  expect(chat.status).toBeGreaterThanOrEqual(400);
  await h.request("/api/decision/cancel", { id: started.run_id });
  await idle();
}, 90_000);
