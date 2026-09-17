import { appendFileSync, mkdirSync } from "node:fs";

import type { Observation } from "@robo/domain";
import { Effect, Schema } from "effect";

import { running as chatsRunning } from "../chat-runs";
import { config } from "../config";
import { agentControlSignal } from "../control-lifecycle";
import { activeDecisionRuns, motionExecutor } from "../motion-executor";
import * as robot from "../robot";
import { emit } from "../store";
import { ToolFailure } from "../tool-errors";
import { whiteBlob } from "./blob";
import { candidates, defaultLimits, type Action } from "./candidates";
import { jevEvaluator, jevRate, memoryMeter } from "./jev";
import { runDecisionLoop } from "./loop";
import { mockEvaluator, mockTacticsEvaluator } from "./mock";
import { pickupPerception } from "./perception";
import { pickupDefaults, pickupTracker } from "./pickup";
import { sceneConfig } from "./scene";
import { buildScene } from "./scene-state";
import { runSkillLoop } from "./skill-loop";
import {
  newMemory,
  skillDefaults,
  type MoveOutcome,
  type SkillConfig,
  type WristView,
} from "./skills";
import { sqliteMeter } from "./spend";
import { QUESTION_VERSION } from "./state";
import { deciderFor, strategyNames } from "./strategies";
import { jevTactician, rulesTactician } from "./tactics";
import {
  parseGoal,
  resolveTask,
  stageTracker,
  TaskName,
  type ResolvedTask,
  type TaskTracker,
} from "./tasks";

const withDefault = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

export const DecisionRunRequest = Schema.Struct({
  task: withDefault(TaskName, "control-smoke"),
  strategy: withDefault(Schema.Literals(strategyNames), "choice"),
  decider: withDefault(Schema.Literals(["jev", "mock"]), "jev"),
  mode: withDefault(Schema.Literals(["dry-run", "execute"]), "dry-run"),
  goal: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  max_steps: withDefault(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 400 })),
    10
  ),
  max_seconds: withDefault(
    Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 900 })),
    60
  ),
  /** Pickup: absolute reviewed hover pose, e.g. "shoulder_pan=-8.9,shoulder_lift=-0.9,elbow_flex=6.5,wrist_flex=84.5". */
  hover: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  /** Pickup: model gripper-frame z (m) to descend to. */
  grasp_z: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: -0.2, maximum: 0.3 }))
  ),
  /** Pickup: "x,y" where the piece appears in the wrist image when held between the jaws. */
  grasp_point: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
  open_percent: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 10, maximum: 90 }))
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

/**
 * Supervised envelopes for the real arm. The brief's 20 steps / 60 s covers
 * control smokes; a pickup is ~150 bounded steps, so the operator approved a
 * larger envelope for that task only (2026-09-17).
 */
const realEnvelope: Record<TaskName, { steps: number; seconds: number }> = {
  "control-smoke": { steps: 20, seconds: 60 },
  "pickup-white-piece": { steps: 250, seconds: 720 },
  // Skill-level pickup (09-17, Kris approved unattended attempts): max_steps counts bounded moves.
  "pickup-skills": { steps: 400, seconds: 720 },
};

const parsePoint = (text: string) => {
  const match =
    /^\s*(?<x>-?\d+(?:\.\d+)?)\s*,\s*(?<y>-?\d+(?:\.\d+)?)\s*$/u.exec(text);
  const x = Number(match?.groups?.["x"]);
  const y = Number(match?.groups?.["y"]);
  if (!match || Math.abs(x) > 1 || Math.abs(y) > 1) {
    throw new Error(`grasp_point must be "x,y" in [-1, 1], got "${text}"`);
  }
  return { x, y };
};

const trackerFor = (
  request: DecisionRunRequest,
  task: ResolvedTask,
  obs: Observation
): TaskTracker => {
  if (task.name !== "pickup-white-piece") {
    return stageTracker(task, defaultLimits);
  }
  if (request.hover === undefined || request.grasp_z === undefined) {
    throw new Error(
      "pickup-white-piece needs a reviewed hover pose and grasp_z"
    );
  }
  if (/[+-]=/u.test(request.hover)) {
    throw new Error("hover must be absolute joint values (joint=N)");
  }
  return pickupTracker({
    ...pickupDefaults,
    hover: parseGoal(request.hover, obs),
    graspZ: request.grasp_z,
    graspPoint: request.grasp_point
      ? parsePoint(request.grasp_point)
      : pickupDefaults.graspPoint,
    openPercent: request.open_percent ?? pickupDefaults.openPercent,
  });
};

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

const skillConfigFor = (
  request: DecisionRunRequest,
  obs: Observation
): SkillConfig => ({
  ...skillDefaults,
  graspPoint: request.grasp_point
    ? parsePoint(request.grasp_point)
    : skillDefaults.graspPoint,
  openPercent: request.open_percent ?? skillDefaults.openPercent,
  limits: obs.limits,
});

const lookWrist = async (): Promise<WristView> => {
  try {
    const detection = whiteBlob(await robot.capture("wrist"));
    const x = detection["center_x"];
    const y = detection["center_y"];
    const visible =
      detection["visible"] === true &&
      typeof x === "number" &&
      typeof y === "number";
    return {
      visible,
      x: visible ? x : null,
      y: visible ? y : null,
      size:
        typeof detection["area_fraction"] === "number"
          ? detection["area_fraction"]
          : 0,
      background: detection["background"] === true,
    };
  } catch {
    return { visible: false, x: null, y: null, size: 0, background: false };
  }
};

/** Read-only preview: the state a decision would see now, with no model call or motion. */
export const previewDecision = async (request: DecisionRunRequest) => {
  const obs = await robot.motionIO.observe(AbortSignal.timeout(3000));
  if (request.task === "pickup-skills") {
    const config = skillConfigFor(request, obs);
    const view = await lookWrist();
    const scene = buildScene({
      obs,
      view,
      config,
      memory: newMemory(),
      last: null,
      repeats: 0,
      unseenSteps: view.visible ? 0 : 1,
      skillsRun: 0,
      maxMoves: request.max_steps,
      graspHeightReachedAtM: null,
    });
    const judgment = await rulesTactician().judge(
      scene,
      AbortSignal.timeout(1000)
    );
    return {
      backend: obs.backend,
      fault: obs.fault,
      operator: obs.operator,
      measured: obs.measured,
      scene,
      rules_next: judgment.next,
      motor_writes: 0,
    };
  }
  let task;
  let tracker;
  try {
    task = resolveTask(request.task, obs, request.goal);
    tracker = trackerFor(request, task, obs);
  } catch (error) {
    throw new robot.ApiError(
      error instanceof Error ? error.message : "Invalid task",
      422
    );
  }
  const detections =
    task.name === "pickup-white-piece"
      ? await pickupPerception({
          capture: (camera) => robot.capture(camera),
          scene: null,
          sceneEvery: 1,
        }).perceive(obs, AbortSignal.timeout(5000))
      : [];
  const view = tracker.advance(obs, detections);
  return {
    backend: obs.backend,
    boot_id: obs.boot_id,
    age_ms: Math.round(obs.age_ms),
    fault: obs.fault,
    operator: obs.operator,
    measured: obs.measured,
    ee_xyz_m: obs.ee.slice(0, 3),
    task: {
      name: task.name,
      phase: view.phase,
      goal: view.goal,
      instruction: view.instruction,
    },
    metrics: view.metrics,
    detections,
    candidates: candidates(
      obs,
      { goal: view.goal, explore: view.explore },
      defaultLimits
    ).map((action) => action.id),
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
    const envelope = realEnvelope[request.task];
    if (
      request.max_steps > envelope.steps ||
      request.max_seconds > envelope.seconds
    ) {
      throw new robot.ApiError(
        `Supervised ${request.task} envelope is at most ${envelope.steps} steps and ${envelope.seconds} s`,
        403
      );
    }
  }
  let task;
  let tracker;
  try {
    task = resolveTask(request.task, first, request.goal);
    tracker = trackerFor(request, task, first);
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
      if (task.name === "pickup-skills") {
        const config = skillConfigFor(request, first);
        const tactician =
          request.strategy === "rules"
            ? rulesTactician()
            : jevTactician(
                request.decider === "mock"
                  ? mockTacticsEvaluator(memoryMeter(rate, 10))
                  : jevEvaluator({
                      meter: sqliteMeter(rate),
                      timeoutMs: request.timeout_ms,
                    })
              );
        let moveCount = 0;
        const owner = `decision-${runId}`;
        const observe = () =>
          robot.motionIO.observe(
            AbortSignal.any([signal, AbortSignal.timeout(3000)])
          );
        const move = async (
          target: Parameters<
            typeof motionExecutor.execute
          >[0]["input"]["target"],
          durationS: number
        ): Promise<MoveOutcome> => {
          moveCount += 1;
          if (request.mode !== "execute") {
            return { status: "refused", after: null, message: "dry-run" };
          }
          try {
            const outcome = await motionExecutor.execute({
              id: `decision:${runId}:m${moveCount}`,
              owner,
              input: { ...(target ? { target } : {}), duration_s: durationS },
              signal,
              progress: () => {},
            });
            const after = await observe().catch(() => null);
            log("move", {
              n: moveCount,
              target,
              status: outcome.status,
              residual: outcome.operation?.residual ?? null,
            });
            return { status: outcome.status, after, message: outcome.message };
          } catch (error) {
            const message =
              error instanceof ToolFailure ? error.message : String(error);
            log("move", {
              n: moveCount,
              target,
              status: "refused",
              error: message,
            });
            return {
              status: "refused",
              after: await observe().catch(() => null),
              message,
            };
          }
        };
        const summary = await runSkillLoop(
          {
            observe,
            look: () => lookWrist(),
            move,
            tactician,
            log: (event, data) => {
              log(event, data);
            },
          },
          {
            mode: request.mode,
            config,
            maxMoves: request.max_steps,
            maxSeconds: request.max_seconds,
            maxJudgments: 80,
            signal,
          }
        );
        log("finished", {
          ...summary,
          tactician: tactician.name,
          seconds: Math.round((Date.now() - startedEvent.time) / 100) / 10,
        });
        return;
      }
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
          ...(perception ? { perceive: perception.perceive } : {}),
          onOffered: (next) => {
            offered = next;
          },
        },
        {
          runId,
          mode: request.mode,
          task,
          tracker,
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
