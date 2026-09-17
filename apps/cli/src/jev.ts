#!/usr/bin/env bun
/**
 * Jev decision experiment CLI. A thin client of the coordinator's decision
 * runner; nothing here talks to motors, cameras or model providers directly.
 *
 *   bun run jev --smoke [--mock]                      Gateway proof (no robot)
 *   bun run jev --observe [--task T] [--goal G]       read-only state + candidates
 *   bun run jev --fixtures --strategy S [--mock]      offline decision fixtures
 *   bun run jev --dry-run [run options]               live decisions, no motion
 *   bun run jev --execute --supervised [run options]  bounded motion (real arm: after the operator's go)
 *   bun run jev --status | --cancel ID
 *
 * Pickup: --hover "shoulder_pan=-8.9,shoulder_lift=-0.9,elbow_flex=6.5,wrist_flex=84.5" --grasp-z -0.03
 *   [--grasp-point -0.16,0.09] [--open 55] [--scene [--scene-model M]]
 * Recording: --record "label" wraps an --execute run in a recording, then exports an MP4 (both cameras).
 * Run options: --task control-smoke|pickup-white-piece|pickup-skills  --strategy choice|parallel|critic|rules
 *   --mock (SDK mock instead of Jev)  --goal joint+=4,joint=-8.5,...  --max-steps N  --max-seconds N  --timeout-ms N
 * ROBO_URL selects the coordinator (default http://127.0.0.1:8940); ROBO_TOKEN in token mode.
 * No mode flag prints this help and never moves anything.
 */
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    smoke: { type: "boolean" },
    observe: { type: "boolean" },
    fixtures: { type: "boolean" },
    "dry-run": { type: "boolean" },
    execute: { type: "boolean" },
    status: { type: "boolean" },
    cancel: { type: "string" },
    supervised: { type: "boolean" },
    mock: { type: "boolean" },
    task: { type: "string" },
    strategy: { type: "string" },
    goal: { type: "string" },
    "max-steps": { type: "string" },
    "max-seconds": { type: "string" },
    "timeout-ms": { type: "string" },
    hover: { type: "string" },
    "grasp-z": { type: "string" },
    "grasp-point": { type: "string" },
    open: { type: "string" },
    scene: { type: "boolean" },
    "scene-model": { type: "string" },
    record: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

const base = process.env["ROBO_URL"] ?? "http://127.0.0.1:8940";
const token = process.env["ROBO_TOKEN"];
const headers = {
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  "Content-Type": "application/json",
};

type Body = Readonly<Record<string, string | number | boolean>>;

const call = async (path: string, body?: Body) => {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? null : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data
        ? String(data.error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
};

const print = (value: unknown) => {
  console.log(JSON.stringify(value, null, 2));
};

const numberArg = (
  name: "max-steps" | "max-seconds" | "timeout-ms" | "grasp-z" | "open"
) =>
  args[name] === undefined
    ? {}
    : { [name.replaceAll("-", "_")]: Number(args[name]) };

const runBody = (mode: "dry-run" | "execute") => ({
  mode,
  decider: args.mock ? "mock" : "jev",
  ...(args.task ? { task: args.task } : {}),
  ...(args.strategy ? { strategy: args.strategy } : {}),
  ...(args.goal ? { goal: args.goal } : {}),
  ...numberArg("max-steps"),
  ...numberArg("max-seconds"),
  ...numberArg("timeout-ms"),
  ...numberArg("grasp-z"),
  ...(args.open === undefined ? {} : { open_percent: Number(args.open) }),
  ...(args.hover ? { hover: args.hover } : {}),
  ...(args["grasp-point"] ? { grasp_point: args["grasp-point"] } : {}),
  ...(args.scene ? { scene: true } : {}),
  ...(args["scene-model"] ? { scene_model: args["scene-model"] } : {}),
  supervised: Boolean(args.supervised),
});

interface StreamEvent {
  readonly id: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

const brief = (event: StreamEvent) => {
  const d = event.data;
  const decision = (d["decision"] ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "decision.step": {
      return `step ${String(d["step"])} [stage ${String(d["stage"])}] ${String(decision["strategy"] ?? "")} → ${String(decision["action_id"] ?? "?")} (${String(decision["latency_ms"] ?? "-")} ms${decision["note"] ? `, ${String(decision["note"])}` : ""}) · ${String(d["verdict"])} · ${String(d["outcome"])}${d["residual"] === undefined || d["residual"] === null ? "" : ` · residual ${String(d["residual"])}`}`;
    }
    case "decision.decision_failed": {
      return `step ${String(d["step"])} decider ${String(d["failure"])}: ${String(d["error"])}`;
    }
    case "decision.tactics": {
      return `tactics ${String(d["turn"])}: ${String(d["source"])} → ${String(d["next"])}${d["chosen"] === d["next"] ? "" : ` (code chose ${String(d["chosen"])}: ${String(d["veto"])})`}${d["risk"] === null || d["risk"] === undefined ? "" : ` · risk ${String(d["risk"])}`} · ${String(d["latency_ms"])} ms`;
    }
    case "decision.skill_finished": {
      return `  skill ${String(d["skill"])} → ${String(d["result"])}: ${String(d["detail"])} (${String(d["moves"])} moves, ${String(d["moves_used"])} total)`;
    }
    case "decision.skill_aborted":
    case "decision.tactics_failed": {
      return `  ${event.type}: ${String(d["error"])}`;
    }
    case "decision.stage_reached": {
      return `stage ${String(d["stage"])} reached`;
    }
    case "decision.observe_failed": {
      return `observe failed: ${String(d["error"])}`;
    }
    default: {
      return null;
    }
  }
};

/** Follow the run's events over SSE until it finishes; Ctrl-C cancels the run. */
const follow = async (runId: string, after: number) => {
  const abort = new AbortController();
  const onSignal = () => {
    void call("/api/decision/cancel", { id: runId }).finally(() => {
      console.error("cancel requested");
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const response = await fetch(`${base}/api/events?after=${after - 1}`, {
    headers,
    signal: abort.signal,
  });
  if (!response.body) throw new Error("Event stream unavailable");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += chunk.value;
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((part) => part.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as StreamEvent;
      if (event.data["run_id"] !== runId) continue;
      const text = brief(event);
      if (text) console.log(text);
      if (event.type === "decision.finished") {
        abort.abort();
        print(event.data);
        return event.data;
      }
    }
  }
  return null;
};

interface RecordingInfo {
  readonly id: string;
}

const startRecording = async (label: string): Promise<RecordingInfo> => {
  const recording = (await call("/api/tool/recording_start", {
    label: label.slice(0, 120),
  })) as { id: string };
  console.log(`recording ${recording.id}`);
  // Let the first camera samples land before motion starts.
  await Bun.sleep(1500);
  return recording;
};

/** Stop the recording even after a failed or cancelled run, then export an MP4 of both cameras. */
const finishRecording = async (
  recording: RecordingInfo,
  label: string,
  finished: Record<string, unknown> | null
) => {
  await Bun.sleep(1500);
  const stopped = (await call("/api/tool/recording_stop", {})) as {
    state?: string;
    frames?: number;
  };
  console.log(
    `recording ${recording.id} ${stopped.state ?? "stopped"}, ${stopped.frames ?? "?"} frames`
  );
  const outcome =
    finished?.["end_reason"] === "done" && finished["task_complete"] === true
      ? "success"
      : "failure";
  try {
    const exported = (await call("/api/tool/recording_export", {
      id: recording.id,
      kind: "mp4",
      task: label.slice(0, 200),
      outcome,
      camera: "both",
      speed: 4,
      overlay: true,
    })) as { url?: string | null; state?: string };
    console.log(`mp4 ${exported.state ?? ""} ${base}${exported.url ?? ""}`);
  } catch (error) {
    console.error(
      `MP4 export failed (${error instanceof Error ? error.message : String(error)}); export shorter intervals from the workbench Recordings tab`
    );
  }
  console.log(`replay ${base}/api/recordings/${recording.id}/replay.rrd`);
};

const main = async () => {
  if (args.smoke) {
    const result = (await call("/api/decision/smoke", {
      decider: args.mock ? "mock" : "jev",
    })) as {
      status?: string;
    };
    print(result);
    process.exitCode =
      result.status === "passed" ? 0 : result.status === "blocked" ? 2 : 1;
  } else if (args.observe) {
    print(await call("/api/decision/observe", runBody("dry-run")));
  } else if (args.fixtures) {
    print(
      await call("/api/decision/fixtures", {
        strategy: args.strategy ?? "choice",
        decider: args.mock ? "mock" : "jev",
      })
    );
  } else if (args["dry-run"] || args.execute) {
    const recording =
      args.record && args.execute ? await startRecording(args.record) : null;
    let finished: Record<string, unknown> | null = null;
    try {
      const started = (await call(
        "/api/decision/runs",
        runBody(args.execute ? "execute" : "dry-run")
      )) as {
        run_id: string;
        event_id: number;
        log_path: string;
      };
      console.log(`run ${started.run_id} · log ${started.log_path}`);
      finished = await follow(started.run_id, started.event_id);
    } finally {
      if (recording) {
        await finishRecording(
          recording,
          args.record ?? "decision run",
          finished
        );
      }
    }
  } else if (args.status) {
    print(await call("/api/decision"));
  } else if (args.cancel) {
    print(await call("/api/decision/cancel", { id: args.cancel }));
  } else {
    const source = await Bun.file(import.meta.path).text();
    console.log(
      (source.split("*/")[0] ?? "")
        .replace(/^#!.*\n\/\*\*\n/u, "")
        .replaceAll(/^ \* ?/gmu, "")
    );
  }
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
