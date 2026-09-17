import { appendFileSync, mkdirSync } from "node:fs";

import { Effect, Schema } from "effect";

import { running as chatsRunning } from "../chat-runs";
import { config } from "../config";
import { agentControlSignal } from "../control-lifecycle";
import { activeDecisionRuns, motionExecutor } from "../motion-executor";
import * as robot from "../robot";
import { emit } from "../store";
import { candidates, defaultLimits, type Action } from "./candidates";
import { jevEvaluator, jevRate, memoryMeter } from "./jev";
import { runDecisionLoop } from "./loop";
import { mockEvaluator } from "./mock";
import { pickupPerception } from "./perception";
import { sceneConfig } from "./scene";
import { sqliteMeter } from "./spend";
import { QUESTION_VERSION } from "./state";
import { deciderFor, strategyNames } from "./strategies";
import { resolveTask, specFor, TaskName } from "./tasks";

const withDefault = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

export const DecisionRunRequest = Schema.Struct({
  task: withDefault(TaskName, "control-smoke"),
  strategy: withDefault(Schema.Literals(strategyNames), "choice"),
  decider: withDefault(Schema.Literals(["jev", "mock"]), "jev"),
  mode: withDefault(Schema.Literals(["dry-run", "execute"]), "dry-run"),
  goal: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  max_steps: withDefault(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
    10
  ),
  max_seconds: withDefault(
    Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 600 })),
    60
  ),
  supervised: withDefault(Schema.Boolean, false),
  scene: withDefault(Schema.Boolean, false),
  scene_model: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80))
  ),
  scene_every: withDefault(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
    5
  ),
  timeout_ms: withDefault(
    Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 30_000 })),
    8000
  ),
});
export type DecisionRunRequest = typeof DecisionRunRequest.Type;

/** Supervised envelope for the real arm, per the experiment brief. */
const REAL_MAX_STEPS = 20;
const REAL_MAX_SECONDS = 60;

interface RunHandle {
  readonly abort: AbortController;
  readonly request: DecisionRunRequest;
  readonly started: number;
  readonly logPath: string;
  readonly done: Promise<null>;
}
const runs = new Map<string, RunHandle>();

export const decisionRuns = () =>
  [...runs.entries()].map(([id, run]) => ({
    run_id: id,
    ...run.request,
    started: run.started,
    log_path: run.logPath,
  }));

export const cancelDecisionRun = (id: string) => {
  runs.get(id)?.abort.abort(new Error("Cancelled by operator"));
  return { cancelled: runs.has(id) };
};

export const closeDecisionRuns = async () => {
  const active = [...runs.values()];
  for (const run of active)
    run.abort.abort(new Error("Coordinator shutting down"));
  await Promise.all(active.map((run) => run.done));
};

/** Read-only preview: the state a decision would see now, with no model call. */
export const previewDecision = async (
  task: TaskName,
  goal: string | undefined
) => {
  const obs = await robot.motionIO.observe(AbortSignal.timeout(3000));
  const resolved = resolveTask(task, obs, goal);
  return {
    backend: obs.backend,
    boot_id: obs.boot_id,
    age_ms: Math.round(obs.age_ms),
    fault: obs.fault,
    operator: obs.operator,
    measured: obs.measured,
    task: resolved,
    candidates: candidates(obs, specFor(resolved, 0), defaultLimits).map(
      (action) => action.id
    ),
    motor_writes: 0,
  };
};

export const startDecisionRun = async (request: DecisionRunRequest) => {
  if (runs.size > 0) {
    throw new robot.ApiError("A decision run is already active", 409);
  }
  if (chatsRunning().length > 0) {
    throw new robot.ApiError(
      "A chat conversation is running; finish or cancel it first",
      409
    );
  }
  if (
    request.decider === "jev" &&
    request.strategy !== "rules" &&
    !process.env["AI_GATEWAY_API_KEY"]
  ) {
    throw new robot.ApiError(
      "AI_GATEWAY_API_KEY is not set in the coordinator environment (~/.config/robo-harness.env)",
      412
    );
  }
  const scene = request.scene ? sceneConfig(request.scene_model) : null;
  if (request.scene && !scene) {
    throw new robot.ApiError(
      "Scene description needs CLIPROXY_API_KEY or ROBO_SCENE_API_KEY in the coordinator environment",
      412
    );
  }
  const first = await robot.motionIO.observe(AbortSignal.timeout(3000));
  if (request.mode === "execute" && first.backend === "so101") {
    if (!request.supervised) {
      throw new robot.ApiError(
        "Real-arm execution requires supervised: true after the operator's go",
        403
      );
    }
    if (
      request.max_steps > REAL_MAX_STEPS ||
      request.max_seconds > REAL_MAX_SECONDS
    ) {
      throw new robot.ApiError(
        `Supervised trial envelope is at most ${REAL_MAX_STEPS} steps and ${REAL_MAX_SECONDS} s`,
        403
      );
    }
  }
  let task;
  try {
    task = resolveTask(request.task, first, request.goal);
  } catch (error) {
    throw new robot.ApiError(
      error instanceof Error ? error.message : "Invalid goal",
      422
    );
  }
  const runId = crypto.randomUUID();
  const dir = `${config.dataDir}/decision-runs`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logPath = `${dir}/${runId}.jsonl`;
  const log = (event: string, data: Record<string, unknown>) => {
    const line = { t: new Date().toISOString(), run_id: runId, event, ...data };
    appendFileSync(logPath, `${JSON.stringify(line)}\n`);
    return emit(`decision.${event}`, { run_id: runId, ...data });
  };
  const rate = await jevRate();
  let offered: readonly Action[] = [];
  const evaluate =
    request.decider === "mock"
      ? mockEvaluator(memoryMeter(rate, 10), () => offered)
      : jevEvaluator({
          meter: sqliteMeter(rate),
          timeoutMs: request.timeout_ms,
        });
  const decider = deciderFor(request.strategy, evaluate);
  const perception =
    task.name === "pickup-white-piece"
      ? pickupPerception({
          capture: (camera) => robot.capture(camera),
          scene,
          sceneEvery: request.scene_every,
        })
      : null;
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, agentControlSignal()]);
  const startedEvent = log("started", {
    ...request,
    backend: first.backend,
    boot_id: first.boot_id,
    start_measured: first.measured,
    stages: task.stages,
    limits: defaultLimits,
    question_version: QUESTION_VERSION,
    rate,
    scene_model: scene?.model ?? null,
    log_path: logPath,
  });
  activeDecisionRuns.add(runId);
  const settled = Promise.withResolvers<null>();
  runs.set(runId, {
    abort,
    request,
    started: startedEvent.time,
    logPath,
    done: settled.promise,
  });
  void (async () => {
    try {
      const summary = await runDecisionLoop(
        {
          observe: (runSignal) =>
            robot.motionIO.observe(
              AbortSignal.any([runSignal, AbortSignal.timeout(3000)])
            ),
          execute: (actionRequest) => motionExecutor.execute(actionRequest),
          decider,
          log: (event, data) => {
            log(event, data);
          },
          sleep: (ms) => Bun.sleep(ms),
          ...(perception
            ? {
                perceive: perception.perceive,
                perceivedComplete: perception.complete,
              }
            : {}),
          onOffered: (next) => {
            offered = next;
          },
        },
        {
          runId,
          mode: request.mode,
          task,
          limits: defaultLimits,
          maxSteps: request.max_steps,
          maxSeconds: request.max_seconds,
          signal,
        }
      );
      log("finished", {
        ...summary,
        seconds: Math.round((Date.now() - startedEvent.time) / 100) / 10,
      });
    } catch (error) {
      log("finished", {
        end_reason: `error: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      await robot.release(`decision-${runId}`).catch(() => {});
      activeDecisionRuns.delete(runId);
      runs.delete(runId);
    }
  })().finally(() => settled.resolve(null));
  return { run_id: runId, event_id: startedEvent.id, log_path: logPath };
};
