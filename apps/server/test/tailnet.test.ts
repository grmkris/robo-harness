import { afterAll, beforeAll, expect, test } from "bun:test";

import { type Harness, startHarness } from "./harness";

let h: Harness;
let base: string;
beforeAll(async () => {
  h = await startHarness({
    accessMode: "tailnet",
    withIo: false,
    withFixture: false,
  });
  base = h.base;
}, 30_000);
afterAll(async () => {
  await h.close();
});

test("tailnet browser opens without a token and keeps browser identities distinct", async () => {
  const a = await fetch(`${base}/api/status`, {
    headers: { "X-Robo-Browser": "browser-a" },
  });
  const b = await fetch(`${base}/api/status`, {
    headers: { "X-Robo-Browser": "browser-b" },
  });
  const one = (await a.json()) as any;
  const two = (await b.json()) as any;
  expect(a.status).toBe(200);
  expect(one.access_mode).toBe("tailnet");
  expect(one.controller).not.toBe(two.controller);
});
test("tokenless external clients retain agent control semantics", async () => {
  const r = await fetch(`${base}/api/tool/acquire`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Robo-Controller": "mcp-test",
    },
    body: JSON.stringify({ mode: "human", takeover: true }),
  });
  expect(r.status).toBe(403);
});
test("expired program credentials cannot become an operator and foreign origins cannot issue commands", async () => {
  expect(
    (
      await fetch(`${base}/api/status`, {
        headers: { Authorization: "Bearer expired-program" },
      })
    ).status
  ).toBe(401);
  const r = await fetch(`${base}/api/tool/stop`, {
    method: "POST",
    headers: {
      Origin: "https://unrelated.example",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  expect(r.status).toBe(403);
});
