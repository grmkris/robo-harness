import { mkdir, writeFile } from "node:fs/promises";

import { z } from "zod";

import { config } from "./config";
import { capture, ApiError } from "./robot";
import { db, emit } from "./store";
export const resultSchema = z.object({
  kind: z.enum(["segment", "depth"]),
  model: z.string(),
  model_version: z.string(),
  frame_id: z.string(),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  preview_png: z.string(),
  masks: z
    .array(
      z.object({
        png: z.string(),
        label: z.string(),
        score: z.number().optional(),
      })
    )
    .optional(),
  depth: z.array(z.array(z.number().finite()).max(2048)).max(2048).optional(),
  depth_width: z.number().int().positive().optional(),
  depth_height: z.number().int().positive().optional(),
  depth_to_image: z.array(z.array(z.number().finite())).optional(),
  units: z.enum(["relative", "meters", "pixels"]).optional(),
});
export function budget() {
  return db
    .query("SELECT limit_usd,spent_usd FROM budgets WHERE id=1")
    .get() as { limit_usd: number; spent_usd: number } | null;
}
export function setBudget(limit: number) {
  if (!Number.isFinite(limit) || limit < 0 || limit > 1000)
    throw new ApiError("Budget must be between 0 and 1000 USD", 400);
  const existing = budget();
  if (existing && limit < existing.spent_usd)
    throw new ApiError("Budget cannot be below already reserved spending");
  db.query(
    "INSERT INTO budgets(id,limit_usd,spent_usd) VALUES(1,?,0) ON CONFLICT(id) DO UPDATE SET limit_usd=excluded.limit_usd"
  ).run(limit);
  emit("budget.updated", { limit_usd: limit });
  return budget();
}
export function perceptionConfig() {
  return {
    configured: Boolean(
      process.env.ROBO_PERCEPTION_URL || process.env.ROBO_FAL_ENDPOINT
    ),
    provider: process.env.ROBO_FAL_ENDPOINT ? "fal" : "worker",
    cost_usd: Number(process.env.ROBO_PERCEPTION_COST_USD ?? 0),
    budget: budget(),
  };
}
export async function perceive(
  input: {
    camera: string;
    kind: "segment" | "depth";
    prompt: string;
    frame_id?: string;
  },
  signal?: AbortSignal
) {
  const settings = perceptionConfig();
  if (!settings.configured)
    throw new ApiError(
      "Configure a perception worker or compatible fal endpoint first",
      422
    );
  if (!Number.isFinite(settings.cost_usd) || settings.cost_usd <= 0)
    throw new ApiError(
      "Configure a conservative maximum cost per request before enabling paid perception",
      422
    );
  const frame = await capture(input.camera, input.frame_id);
  const reserve = db
    .query(
      "UPDATE budgets SET spent_usd=spent_usd+? WHERE id=1 AND spent_usd+?<=limit_usd"
    )
    .run(settings.cost_usd, settings.cost_usd);
  if (reserve.changes !== 1)
    throw new ApiError("Perception budget is absent or exhausted", 402);
  const id = crypto.randomUUID();
  const source = { ...frame, base64: undefined };
  db.query(
    "INSERT INTO perception(id,state,source,created) VALUES(?,?,?,?)"
  ).run(id, "running", JSON.stringify(source), Date.now());
  emit("perception.started", { id, kind: input.kind, frame_id: frame.id });
  const combined = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(120000),
  ]);
  // The reservation is refunded unless a paid backend accepted the job; after
  // that point the charge stands even if the answer is rejected.
  let charged = false;
  try {
    const body = { kind: input.kind, prompt: input.prompt, frame };
    let raw: unknown;
    if (process.env.ROBO_FAL_ENDPOINT) {
      const endpoint = process.env.ROBO_FAL_ENDPOINT;
      if (!/^[a-zA-Z0-9_/-]+$/.test(endpoint))
        throw new Error("Invalid configured fal endpoint");
      const headers = {
        Authorization: "Key " + process.env.FAL_KEY,
        "Content-Type": "application/json",
      };
      const queued = await fetch("https://queue.fal.run/" + endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: combined,
      });
      if (!queued.ok) throw new Error("fal rejected the inference request");
      charged = true;
      const job = (await queued.json()) as {
        status_url: string;
        response_url: string;
        cancel_url: string;
      };
      const trusted = (value: string) => {
        const u = new URL(value);
        if (u.origin !== "https://queue.fal.run")
          throw new Error("Unexpected fal job URL");
        return value;
      };
      try {
        while (true) {
          combined.throwIfAborted();
          const response = await fetch(trusted(job.status_url), {
            headers,
            signal: combined,
          });
          if (!response.ok) throw new Error("fal status request failed");
          const state = (await response.json()) as {
            status: string;
            error?: string;
          };
          if (state.error) throw new Error("fal inference failed");
          if (state.status === "COMPLETED") break;
          await Bun.sleep(500);
        }
        const response = await fetch(trusted(job.response_url), {
          headers,
          signal: combined,
        });
        if (!response.ok) throw new Error("fal result unavailable");
        raw = await response.json();
      } catch (e) {
        await fetch(trusted(job.cancel_url), {
          method: "PUT",
          headers,
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
        throw e;
      }
    } else {
      const response = await fetch(
        process.env.ROBO_PERCEPTION_URL! + "/infer",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + process.env.ROBO_PERCEPTION_TOKEN,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: combined,
        }
      );
      if (!response.ok)
        throw new Error(
          "Perception worker failed with status " + response.status
        );
      charged = true;
      raw = await response.json();
    }
    const result = resultSchema.parse(raw);
    if (result.frame_id !== frame.id || result.kind !== input.kind)
      throw new Error(
        "Perception response does not match source frame or requested capability"
      );
    if (result.width !== frame.width || result.height !== frame.height)
      throw new Error("Perception image geometry does not match source frame");
    const path = config.dataDir + "/perception/" + id;
    await mkdir(path, { recursive: true });
    await writeFile(
      path + "/preview.png",
      Buffer.from(result.preview_png, "base64")
    );
    await writeFile(
      path + "/result.json",
      JSON.stringify({ ...result, source, completed_ms: Date.now() })
    );
    db.query("UPDATE perception SET state='completed',result=? WHERE id=?").run(
      JSON.stringify({ ...result, source, completed_ms: Date.now() }),
      id
    );
    emit("perception.completed", {
      id,
      kind: result.kind,
      model: result.model,
      frame_id: frame.id,
    });
    return { id, ...result, source };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Perception failed";
    if (!charged)
      db.query(
        "UPDATE budgets SET spent_usd=MAX(0,spent_usd-?) WHERE id=1"
      ).run(settings.cost_usd);
    db.query("UPDATE perception SET state='failed',error=? WHERE id=?").run(
      message,
      id
    );
    emit("perception.failed", { id, message });
    throw new ApiError(message, 502);
  }
}
