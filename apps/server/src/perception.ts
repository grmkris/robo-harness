import { mkdir, writeFile } from "node:fs/promises";

import { Schema } from "effect";

import { config } from "./config";
import { capture, ApiError } from "./robot";
import { db, emit } from "./store";

// These responses reject a submission before inference. Transport failures,
// timeouts and server errors do not establish whether work was accepted.
const REJECTED_SUBMISSION_STATUSES = new Set([
  400, 401, 403, 404, 405, 413, 415, 422, 429,
]);

const Pixels = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(4096)
);
const resultSchema = Schema.Struct({
  kind: Schema.Literals(["segment", "depth"]),
  model: Schema.String,
  model_version: Schema.String,
  frame_id: Schema.String,
  width: Pixels,
  height: Pixels,
  preview_png: Schema.String,
  masks: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        png: Schema.String,
        label: Schema.String,
        score: Schema.optionalKey(Schema.Finite),
      })
    )
  ),
  depth: Schema.optionalKey(Schema.Array(Schema.Array(Schema.Finite))),
  depth_width: Schema.optionalKey(Schema.Int),
  depth_height: Schema.optionalKey(Schema.Int),
  depth_to_image: Schema.optionalKey(Schema.Array(Schema.Array(Schema.Finite))),
  units: Schema.optionalKey(Schema.Literals(["relative", "meters", "pixels"])),
});
export function budget() {
  return db
    .query("SELECT limit_usd,spent_usd FROM budgets WHERE id=1")
    .get() as { limit_usd: number; spent_usd: number } | null;
}
export function setBudget(limit: number) {
  if (!Number.isFinite(limit) || limit < 0 || limit > 1000) {
    throw new ApiError("Budget must be between 0 and 1000 USD", 400);
  }
  const existing = budget();
  if (existing && limit < existing.spent_usd) {
    throw new ApiError("Budget cannot be below already reserved spending");
  }
  db.query(
    "INSERT INTO budgets(id,limit_usd,spent_usd) VALUES(1,?,0) ON CONFLICT(id) DO UPDATE SET limit_usd=excluded.limit_usd"
  ).run(limit);
  emit("budget.updated", { limit_usd: limit });
  return budget();
}
export function perceptionConfig() {
  return {
    configured: Boolean(
      process.env["ROBO_PERCEPTION_URL"] || process.env["ROBO_FAL_ENDPOINT"]
    ),
    provider: process.env["ROBO_FAL_ENDPOINT"] ? "fal" : "worker",
    cost_usd: Number(process.env["ROBO_PERCEPTION_COST_USD"] ?? 0),
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
  if (!settings.configured) {
    throw new ApiError(
      "Configure a perception worker or compatible fal endpoint first",
      422
    );
  }
  if (!Number.isFinite(settings.cost_usd) || settings.cost_usd <= 0) {
    throw new ApiError(
      "Configure a conservative maximum cost per request before enabling paid perception",
      422
    );
  }
  const frame = await capture(input.camera, input.frame_id);
  const reserve = db
    .query(
      "UPDATE budgets SET spent_usd=spent_usd+? WHERE id=1 AND spent_usd+?<=limit_usd"
    )
    .run(settings.cost_usd, settings.cost_usd);
  if (reserve.changes !== 1) {
    throw new ApiError("Perception budget is absent or exhausted", 402);
  }
  const id = crypto.randomUUID();
  const source = { ...frame, base64: undefined };
  db.query(
    "INSERT INTO perception(id,state,source,created) VALUES(?,?,?,?)"
  ).run(id, "running", JSON.stringify(source), Date.now());
  emit("perception.started", { id, kind: input.kind, frame_id: frame.id });
  const combined = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(120_000),
  ]);
  // Reserve from the moment submission can reach the provider. Losing the
  // acknowledgement must not free budget that may already have been spent.
  let keepReservation = false;
  const submit = async (url: string, headers: Record<string, string>) => {
    const body = JSON.stringify({
      kind: input.kind,
      prompt: input.prompt,
      frame,
    });
    const destination = new URL(url);
    combined.throwIfAborted();
    keepReservation = true;
    const response = await fetch(destination, {
      method: "POST",
      headers,
      body,
      signal: combined,
    });
    if (REJECTED_SUBMISSION_STATUSES.has(response.status)) {
      keepReservation = false;
    }
    return response;
  };
  try {
    let raw: unknown;
    if (process.env["ROBO_FAL_ENDPOINT"]) {
      const endpoint = process.env["ROBO_FAL_ENDPOINT"];
      if (!/^[a-zA-Z0-9_/-]+$/.test(endpoint)) {
        throw new Error("Invalid configured fal endpoint");
      }
      const headers = {
        Authorization: `Key ${process.env["FAL_KEY"]}`,
        "Content-Type": "application/json",
      };
      const queued = await submit(`https://queue.fal.run/${endpoint}`, headers);
      if (!queued.ok) {
        throw new Error("fal rejected the inference request");
      }
      const job = (await queued.json()) as {
        status_url: string;
        response_url: string;
        cancel_url: string;
      };
      const trusted = (value: string) => {
        const u = new URL(value);
        if (u.origin !== "https://queue.fal.run") {
          throw new Error("Unexpected fal job URL");
        }
        return value;
      };
      try {
        while (true) {
          combined.throwIfAborted();
          const response = await fetch(trusted(job.status_url), {
            headers,
            signal: combined,
          });
          if (!response.ok) {
            throw new Error("fal status request failed");
          }
          const state = (await response.json()) as {
            status: string;
            error?: string;
          };
          if (state.error) {
            throw new Error("fal inference failed");
          }
          if (state.status === "COMPLETED") {
            break;
          }
          await Bun.sleep(500);
        }
        const response = await fetch(trusted(job.response_url), {
          headers,
          signal: combined,
        });
        if (!response.ok) {
          throw new Error("fal result unavailable");
        }
        raw = await response.json();
      } catch (error) {
        await fetch(trusted(job.cancel_url), {
          method: "PUT",
          headers,
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
        throw error;
      }
    } else {
      const response = await submit(
        `${process.env["ROBO_PERCEPTION_URL"]!}/infer`,
        {
          Authorization: `Bearer ${process.env["ROBO_PERCEPTION_TOKEN"]}`,
          "Content-Type": "application/json",
        }
      );
      if (!response.ok) {
        throw new Error(
          "Perception worker failed with status " + response.status
        );
      }
      raw = await response.json();
    }
    const result = Schema.decodeUnknownSync(resultSchema)(raw);
    if (result.frame_id !== frame.id || result.kind !== input.kind) {
      throw new Error(
        "Perception response does not match source frame or requested capability"
      );
    }
    if (result.width !== frame.width || result.height !== frame.height) {
      throw new Error("Perception image geometry does not match source frame");
    }
    const path = `${config.dataDir}/perception/${id}`;
    await mkdir(path, { recursive: true });
    await writeFile(
      `${path}/preview.png`,
      Buffer.from(result.preview_png, "base64")
    );
    await writeFile(
      `${path}/result.json`,
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
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Perception failed";
    if (!keepReservation) {
      db.query(
        "UPDATE budgets SET spent_usd=MAX(0,spent_usd-?) WHERE id=1"
      ).run(settings.cost_usd);
    }
    db.query("UPDATE perception SET state='failed',error=? WHERE id=?").run(
      message,
      id
    );
    emit("perception.failed", {
      id,
      message,
      reservation_retained: keepReservation,
    });
    throw new ApiError(message, 502);
  }
}
