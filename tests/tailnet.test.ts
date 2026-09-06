import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = join(import.meta.dir, "..");
const base = "http://127.0.0.1:18942";
let child: ReturnType<typeof Bun.spawn>;
let directory = "";
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "robo-tailnet-"));
  child = Bun.spawn(["bun", "src/server/main.ts"], {
    cwd: root,
    env: {
      ...process.env,
      ROBO_HOST: "127.0.0.1",
      ROBO_PORT: "18942",
      ROBO_ACCESS_MODE: "tailnet",
      ROBO_DATA_DIR: directory,
      ROBO_IO_URL: "http://127.0.0.1:18949",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  for (let n = 0; n < 60; n++) {
    try {
      if ((await fetch(base + "/api/status")).ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("Tailnet application did not start");
});
afterAll(async () => {
  child?.kill();
  await child?.exited;
  if (directory) await rm(directory, { recursive: true, force: true });
});
test("tailnet browser opens without a token and keeps browser identities distinct", async () => {
  const a = await fetch(base + "/api/status", {
    headers: { "X-Robo-Browser": "browser-a" },
  });
  const b = await fetch(base + "/api/status", {
    headers: { "X-Robo-Browser": "browser-b" },
  });
  const one = (await a.json()) as any,
    two = (await b.json()) as any;
  expect(a.status).toBe(200);
  expect(one.access_mode).toBe("tailnet");
  expect(one.controller).not.toBe(two.controller);
});
test("tokenless external clients retain agent control semantics", async () => {
  const r = await fetch(base + "/api/tool/acquire", {
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
      await fetch(base + "/api/status", {
        headers: { Authorization: "Bearer expired-program" },
      })
    ).status,
  ).toBe(401);
  const r = await fetch(base + "/api/tool/stop", {
    method: "POST",
    headers: {
      Origin: "https://unrelated.example",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  expect(r.status).toBe(403);
});
