/**
 * Headless client for one coordinator chat turn: POST /api/chat as the
 * operator, follow /api/events until that run's chat.finished, return one
 * summary. The robot, the tools and the model loop all stay in the
 * coordinator; this only starts, watches and (on abort) cancels a turn.
 *
 * Operator auth, in the coordinator's order (apps/server/src/main.ts `auth`):
 * a Bearer token equal to the operator token is the human principal
 * `operator-cli` in either access mode. Without one, a tailnet-mode
 * coordinator treats a request from a tailnet address (or loopback, when it is
 * bound there or ROBO_TRUST_LOOPBACK=1) as a human operator by source address.
 * A wrong token is refused outright; it never falls back to address trust.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

import { Schema } from "effect";

const EventId = Schema.Int.check(Schema.isGreaterThan(0));
const StreamEvent = Schema.Struct({
  id: EventId,
  type: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
});
type StreamEvent = typeof StreamEvent.Type;
const Started = Schema.Struct({
  session_id: Schema.String.check(Schema.isMinLength(1)),
  run_id: Schema.String.check(Schema.isMinLength(1)),
  event_id: EventId,
});

/** The operator token: ROBO_TOKEN, else the file ROBO_TOKEN_FILE names, else
 *  the coordinator's own `operator-token` in ROBO_DATA_DIR (default
 *  ~/.local/state/robo-harness). Undefined means rely on address trust. */
const operatorToken = async (): Promise<string | undefined> => {
  if (process.env["ROBO_TOKEN"]) return process.env["ROBO_TOKEN"];
  const path =
    process.env["ROBO_TOKEN_FILE"] ??
    `${process.env["ROBO_DATA_DIR"] ?? `${homedir()}/.local/state/robo-harness`}/operator-token`;
  try {
    return (await readFile(path, "utf-8")).trim() || undefined;
  } catch {
    return undefined;
  }
};

interface CancellationState {
  promise: Promise<unknown> | null;
}

interface ChatTurn {
  readonly provider: string;
  readonly model?: string;
  readonly text: string;
  readonly sessionId?: string;
  readonly stepCap?: number;
  /** Coordinator-enforced wall-clock cap. */
  readonly wallMs?: number;
  /** Maximum time to drain chat.finished after cancellation. */
  readonly cancelWaitMs?: number;
  readonly stallMs?: number;
  readonly systemAppend?: string;
  /** Coordinator base URL; default ROBO_URL or http://127.0.0.1:8940. */
  readonly baseUrl?: string;
  /** Aborting cancels the turn on the coordinator; the summary still comes
   *  back, from the chat.finished the cancellation produces. */
  readonly signal?: AbortSignal;
  /** Every event of this session, as it arrives (progress display, logs). */
  readonly onEvent?: (event: StreamEvent) => void;
}

/**
 * Run one chat turn and resolve with chat.finished's payload plus the session
 * id, the error the run ended with (null on a clean finish) and the last
 * assistant message.
 */
export const runChat = async (turn: ChatTurn) => {
  turn.signal?.throwIfAborted();
  const base =
    turn.baseUrl ?? process.env["ROBO_URL"] ?? "http://127.0.0.1:8940";
  const token = await operatorToken();
  turn.signal?.throwIfAborted();
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "Content-Type": "application/json",
  };
  const post = async (
    path: string,
    body: unknown,
    timeoutMs = 60_000
  ): Promise<unknown> => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof data === "object" && data !== null && "error" in data
          ? String(data.error)
          : `HTTP ${String(response.status)}`;
      throw new Error(`${path}: ${message}`);
    }
    return data;
  };
  const started = Schema.decodeUnknownSync(Started)(
    await post("/api/chat", {
      provider: turn.provider,
      text: turn.text,
      ...(turn.model === undefined ? {} : { model: turn.model }),
      ...(turn.sessionId === undefined ? {} : { session_id: turn.sessionId }),
      ...(turn.stepCap === undefined ? {} : { step_cap: turn.stepCap }),
      ...(turn.stallMs === undefined ? {} : { stall_ms: turn.stallMs }),
      ...(turn.wallMs === undefined ? {} : { wall_ms: turn.wallMs }),
      ...(turn.systemAppend === undefined
        ? {}
        : { system_append: turn.systemAppend }),
    })
  );
  const sessionId = started.session_id;

  const finishWait = new AbortController();
  const cancellation: CancellationState = { promise: null };
  let cancelTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  const onAbort = () => {
    if (cancellation.promise !== null) return;
    cancellation.promise = post(
      "/api/chat/cancel",
      { id: sessionId },
      turn.cancelWaitMs ?? 5000
    ).catch(() => null);
    cancelTimer = setTimeout(() => {
      finishWait.abort(
        new Error(
          "Cancellation outcome unverified: chat.finished was not received"
        )
      );
    }, turn.cancelWaitMs ?? 5000);
  };
  // The server owns the primary cap; this also bounds a lost terminal event.
  const wallTimer =
    turn.wallMs === undefined ? null : setTimeout(onAbort, turn.wallMs);
  turn.signal?.addEventListener("abort", onAbort, { once: true });
  if (turn.signal?.aborted) onAbort();

  let cursor = started.event_id - 1;
  let error: { code: string; message: string } | null = null;
  let finalText: string | null = null;
  try {
    // Reconnect from the last seen id if the event stream drops mid-turn.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      finishWait.signal.throwIfAborted();
      const stream = new AbortController();
      const response = await fetch(`${base}/api/events?after=${cursor}`, {
        headers,
        signal: AbortSignal.any([
          stream.signal,
          finishWait.signal,
          AbortSignal.timeout(30_000),
        ]),
      }).catch(() => null);
      if (!response?.ok || !response.body) {
        await Bun.sleep(1000);
        continue;
      }
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      try {
        let buffer = "";
        for (;;) {
          const chunk = await reader
            .read()
            .catch(() => ({ done: true as const }));
          if (chunk.done) break;
          buffer += chunk.value;
          if (buffer.length > 1_048_576)
            throw new Error("Event stream frame exceeds 1 MiB");
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame
              .split("\n")
              .find((part) => part.startsWith("data: "));
            if (!line) continue;
            const event = Schema.decodeUnknownSync(StreamEvent)(
              JSON.parse(line.slice(6))
            );
            if (event.id <= cursor) continue;
            cursor = event.id;
            if (event.data["session_id"] !== sessionId) continue;
            turn.onEvent?.(event);
            if (event.type === "chat.error") {
              error = {
                code: String(event.data["code"]),
                message: String(event.data["message"]),
              };
            } else if (
              event.type === "chat.message" &&
              event.data["role"] === "assistant"
            ) {
              finalText = String(event.data["text"]);
            } else if (
              event.type === "chat.finished" &&
              event.data["run_id"] === started.run_id
            ) {
              finished = true;
              stream.abort();
              return {
                ...event.data,
                session_id: sessionId,
                provider: turn.provider,
                model: turn.model ?? null,
                error,
                final_text: finalText,
              };
            }
          }
        }
      } finally {
        stream.abort();
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      finishWait.signal.throwIfAborted();
      await Bun.sleep(500);
    }
    throw new Error(`Lost the event stream before ${sessionId} finished`);
  } finally {
    turn.signal?.removeEventListener("abort", onAbort);
    if (!finished) onAbort();
    if (wallTimer !== null) clearTimeout(wallTimer);
    if (cancelTimer !== null) clearTimeout(cancelTimer);
    finishWait.abort();
    if (cancellation.promise !== null) await cancellation.promise;
  }
};
