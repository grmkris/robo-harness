import { expect, test } from "bun:test";

import { startHarness } from "./harness";

for (const outcome of [
  "disconnect",
  "server_error",
  "rejected",
  "rate_limited",
] as const) {
  test(`perception reservation after ${outcome}`, async () => {
    let submissions = 0;
    const worker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req, server) {
        await req.text();
        submissions += 1;
        if (outcome === "disconnect") {
          // The provider consumed the request, then the acknowledgement was lost.
          await server.stop(true);
          return new Response();
        }
        const status =
          outcome === "rejected" ? 422 : outcome === "rate_limited" ? 429 : 500;
        return Response.json({ error: outcome }, { status });
      },
    });
    const h = await startHarness({
      env: {
        ROBO_PERCEPTION_URL: `http://127.0.0.1:${worker.port}`,
        ROBO_FAL_ENDPOINT: "",
      },
    });
    try {
      expect((await h.request("/api/budget", { limit: 0.01 })).status).toBe(
        200
      );
      const result = await h.call("perceive", {
        camera: "workspace",
        kind: "depth",
      });
      expect(result.status).toBe(502);
      expect(submissions).toBe(1);
      const retained = outcome === "disconnect" || outcome === "server_error";
      expect((await h.status()).budget.spent_usd).toBeCloseTo(
        retained ? 0.01 : 0,
        6
      );
      if (retained) {
        const retry = await h.call("perceive", {
          camera: "workspace",
          kind: "depth",
        });
        expect(retry.status).toBe(402);
        expect(submissions).toBe(1);
      }
    } finally {
      await h.close();
      await worker.stop(true);
    }
  }, 15_000);
}
