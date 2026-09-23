#!/usr/bin/env bun
/**
 * Headless chat turn: the coordinator's own agent loop, driven from a shell.
 *
 *   bun run chat --provider cliproxy --model <id> --text "..."
 *     [--step-cap N] [--stall-ms N] [--wall-ms N] [--system-file path] [--session uuid] [--quiet]
 *
 * Prints progress to stderr and ONE JSON line to stdout: chat.finished's
 * payload (duration_ms, steps, tool_calls, invalid_inputs, completed_actions,
 * first_tool_input_valid, usage {input_tokens, output_tokens, calls[, cost]})
 * plus session_id, provider, model, error ({code, message} or null) and
 * final_text. Exit code 0 on a clean finish, 1 when the turn ended in error.
 * Ctrl-C cancels the turn on the coordinator (POST /api/chat/cancel) and still
 * prints the summary.
 *
 * Environment:
 *   ROBO_URL        coordinator (default http://127.0.0.1:8940; the live
 *                   netcup one is http://100.105.51.45:8940)
 *   ROBO_TOKEN      operator token -> the human principal `operator-cli`
 *   ROBO_TOKEN_FILE file holding it; else ${ROBO_DATA_DIR:-~/.local/state/robo-harness}/operator-token
 * With no token, a tailnet-mode coordinator still accepts a request from a
 * tailnet (or trusted loopback) address as a human operator. The provider and
 * model must be ones the coordinator lists (GET /api/status .providers); for
 * cliproxy that means ROBO_CLIPROXY_MODELS in its environment.
 */
import { parseArgs } from "node:util";

import { runChat } from "./chat-client";

const { values: args } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    text: { type: "string" },
    "step-cap": { type: "string" },
    "stall-ms": { type: "string" },
    "wall-ms": { type: "string" },
    "system-file": { type: "string" },
    session: { type: "string" },
    quiet: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

const integer = (name: "step-cap" | "stall-ms" | "wall-ms") => {
  const raw = args[name];
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value))
    throw new Error(`--${name} must be an integer`);
  return value;
};

const brief = (type: string, data: Record<string, unknown>): string | null => {
  switch (type) {
    case "chat.tool": {
      return `step ${String(data["step"])} → ${String(data["name"])} ${JSON.stringify(data["input"])}`;
    }
    case "chat.tool_result": {
      return `  ok ${String(data["name"])} (${String(data["duration_ms"])} ms)`;
    }
    case "chat.tool_error": {
      return `  ${String(data["code"])} ${String(data["name"])}: ${String(data["message"])}`;
    }
    case "chat.message": {
      return data["role"] === "assistant" ? `» ${String(data["text"])}` : null;
    }
    case "chat.error": {
      return `error ${String(data["code"])}: ${String(data["message"])}`;
    }
    default: {
      return null;
    }
  }
};

const main = async () => {
  if (args.help || !args.provider || !args.text) {
    const source = await Bun.file(import.meta.path).text();
    console.error(
      (source.split("*/")[0] ?? "")
        .replace(/^#!.*\n\/\*\*\n/u, "")
        .replaceAll(/^ \* ?/gmu, "")
    );
    process.exitCode = args.help ? 0 : 2;
    return;
  }
  const abort = new AbortController();
  const onSignal = () => {
    console.error("cancel requested");
    abort.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const stepCap = integer("step-cap");
  const stallMs = integer("stall-ms");
  const wallMs = integer("wall-ms");
  const systemAppend = args["system-file"]
    ? await Bun.file(args["system-file"]).text()
    : undefined;
  const summary = await runChat({
    provider: args.provider,
    text: args.text,
    signal: abort.signal,
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.session === undefined ? {} : { sessionId: args.session }),
    ...(stepCap === null ? {} : { stepCap }),
    ...(stallMs === null ? {} : { stallMs }),
    ...(wallMs === null ? {} : { wallMs }),
    ...(systemAppend === undefined ? {} : { systemAppend }),
    onEvent: (event) => {
      if (args.quiet) return;
      const line = brief(event.type, event.data);
      if (line) console.error(line);
    },
  });
  console.log(JSON.stringify(summary));
  process.exitCode = summary.error === null ? 0 : 1;
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
