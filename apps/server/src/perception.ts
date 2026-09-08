import { mkdir, writeFile } from "node:fs/promises";

import { PerceptionResult } from "@robo/domain";
import { Effect, Schema } from "effect";

import { config } from "./config";
import {
  FAL_SEGMENT,
  FAL_DEPTH,
  falInput,
  normalizeFal,
  runFalRequest,
} from "./fal-perception";
import { active } from "./recordings";
import { capture, ApiError } from "./robot";
import { db, emit } from "./store";

// These responses reject a submission before inference. Transport failures,
// timeouts and server errors do not establish whether work was accepted.
const REJECTED_SUBMISSION_STATUSES = new Set([
  400, 401, 403, 404, 405, 413, 415, 422, 429,
]);

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
const backend = (kind: "segment" | "depth") => {
  const catalog =
    process.env[
      kind === "segment"
        ? "ROBO_FAL_SEGMENT_ENDPOINT"
        : "ROBO_FAL_DEPTH_ENDPOINT"
    ];
  if (catalog)
    return {
      provider: "fal",
      endpoint: catalog,
      catalog: true,
      configured:
        Boolean(process.env["FAL_KEY"]) &&
        catalog === (kind === "segment" ? FAL_SEGMENT : FAL_DEPTH),
    };
  const custom = process.env["ROBO_FAL_ENDPOINT"];
  if (custom)
    return {
      provider: "fal",
      endpoint: custom,
      catalog: false,
      configured: Boolean(process.env["FAL_KEY"]),
    };
  return {
    provider: "worker",
    endpoint: process.env["ROBO_PERCEPTION_URL"] ?? "",
    catalog: false,
    configured: Boolean(
      process.env["ROBO_PERCEPTION_URL"] && process.env["ROBO_PERCEPTION_TOKEN"]
    ),
  };
};
export function perceptionConfig() {
  const segment = backend("segment");
  const depth = backend("depth");
  const cost = Number(process.env["ROBO_PERCEPTION_COST_USD"] ?? 0);
  const approved = budget();
  const funded =
    Number.isFinite(cost) &&
    cost > 0 &&
    Boolean(approved && approved.spent_usd + cost <= approved.limit_usd);
  const capability = (item: ReturnType<typeof backend>) => ({
    configured: item.configured,
    ready: item.configured && funded,
    model: item.catalog ? item.endpoint : item.provider,
    reason: item.configured
      ? funded
        ? null
        : "Approve a perception budget in Activity"
      : "Provider or credentials are not configured",
  });
  return {
    configured: segment.configured || depth.configured,
    provider:
      segment.provider === "fal" || depth.provider === "fal" ? "fal" : "worker",
    cost_usd: Number.isFinite(cost) ? cost : 0,
    budget: approved,
    capabilities: { segment: capability(segment), depth: capability(depth) },
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
  const selected = backend(input.kind);
  if (!selected.configured) {
    throw new ApiError(
      "Configure a provider and credentials for the requested perception capability first",
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
  const recording = active;
  const source = {
    ...frame,
    base64: undefined,
    kind: input.kind,
    prompt: input.prompt,
    model: selected.endpoint || selected.provider,
    recording_id:
      recording && frame.wall_time_ms >= recording.created
        ? recording.id
        : null,
    source_saved: true,
  };
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
    const path = `${config.dataDir}/perception/${id}`;
    await mkdir(path, { recursive: true });
    await writeFile(`${path}/source.jpg`, Buffer.from(frame.base64, "base64"));
    let raw: unknown;
    if (selected.provider === "fal") {
      const output = await Effect.runPromise(
        runFalRequest({
          endpoint: selected.endpoint,
          key: process.env["FAL_KEY"] ?? "",
          body: selected.catalog
            ? falInput(frame, input.kind, input.prompt)
            : { kind: input.kind, prompt: input.prompt, frame },
          onSubmit: () => {
            keepReservation = true;
          },
          onRejected: () => {
            keepReservation = false;
          },
        }).pipe(Effect.scoped),
        { signal: combined }
      );
      raw = selected.catalog
        ? await normalizeFal({
            kind: input.kind,
            raw: output.result,
            frame,
            prompt: input.prompt,
            requestId: output.request_id,
            signal: combined,
          })
        : output.result;
    } else {
      const response = await submit(`${selected.endpoint}/infer`, {
        Authorization: `Bearer ${process.env["ROBO_PERCEPTION_TOKEN"]}`,
        "Content-Type": "application/json",
      });
      if (!response.ok) {
        throw new Error(
          "Perception worker failed with status " + response.status
        );
      }
      raw = await response.json();
    }
    const result = Schema.decodeUnknownSync(PerceptionResult)(raw);
    if (result.frame_id !== frame.id || result.kind !== input.kind) {
      throw new Error(
        "Perception response does not match source frame or requested capability"
      );
    }
    if (result.width !== frame.width || result.height !== frame.height) {
      throw new Error("Perception image geometry does not match source frame");
    }
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
