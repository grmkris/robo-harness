import type {
  TerminalClientMessage,
  TerminalServerMessage,
  TerminalSession,
} from "@robo/domain";
import { Effect } from "effect";

import { ApiError } from "./robot";
import { replayBuffer } from "./terminal-buffer";

interface TerminalProcess {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  exited: Promise<number>;
  close: () => Promise<void>;
}
interface TerminalLaunch {
  id: string;
  owner: string;
  cols: number;
  rows: number;
  lifetimeMs: number;
  output: (data: string) => void;
}
export type LaunchTerminal = (
  options: TerminalLaunch
) => Promise<TerminalProcess>;
interface Session {
  info: TerminalSession;
  owner: string;
  process: TerminalProcess | null;
  abort: AbortController;
  done: Promise<void>;
  buffer: ReturnType<typeof replayBuffer>;
  listener: ((event: TerminalServerMessage) => void) | null;
  disconnect: (() => void) | null;
  ticket: { value: string; expires: number } | null;
  idle: ReturnType<typeof setTimeout> | null;
  reason: string;
}
const defaults = { maxSessions: 4, idleMs: 600_000, lifetimeMs: 3_600_000 };
export const createTerminalManager = (
  launch: LaunchTerminal,
  limits = defaults
) => {
  const sessions = new Map<string, Session>();
  const owned = (owner: string, id: string) => {
    const session = sessions.get(id);
    if (!session || session.owner !== owner)
      throw new ApiError("Terminal not found", 404);
    return session;
  };
  const touch = (session: Session) => {
    if (session.idle) clearTimeout(session.idle);
    session.idle = setTimeout(() => {
      session.reason = "Closed after ten minutes without input.";
      session.abort.abort();
    }, limits.idleMs);
  };
  const create = async (
    owner: string,
    size: { cols: number; rows: number }
  ): Promise<TerminalSession> => {
    for (const [id, session] of sessions) {
      if (session.owner !== owner) continue;
      if (session.info.status !== "exited")
        throw new ApiError(
          "A terminal is already open for this workspace",
          409
        );
      session.disconnect?.();
      sessions.delete(id);
    }
    // Reclaim exited sessions first; never evict another operator's process.
    for (const [id, session] of sessions) {
      if (sessions.size < limits.maxSessions) break;
      if (session.info.status === "exited") {
        session.disconnect?.();
        sessions.delete(id);
      }
    }
    if (sessions.size >= limits.maxSessions)
      throw new ApiError("All development terminal slots are in use", 429);
    const ready = Promise.withResolvers<TerminalSession>();
    const session: Session = {
      info: {
        id: crypto.randomUUID(),
        ...size,
        status: "starting",
        exit_code: null,
        expires_at: Date.now() + limits.lifetimeMs,
      },
      owner,
      process: null,
      abort: new AbortController(),
      done: Promise.resolve(),
      buffer: replayBuffer(),
      listener: null,
      disconnect: null,
      ticket: null,
      idle: null,
      reason: "Shell exited.",
    };
    sessions.set(session.info.id, session);
    const lifetime = Effect.fn("Terminal.session")(function* lifetime() {
      const process = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            launch({
              id: session.info.id,
              owner,
              ...size,
              lifetimeMs: limits.lifetimeMs,
              output: (data) => {
                session.buffer.append(data);
                session.listener?.({ type: "output", data });
              },
            }),
          catch: () =>
            new ApiError("Could not start the development container", 502),
        }),
        (running) => Effect.promise(() => running.close())
      );
      session.process = process;
      session.info = { ...session.info, status: "running" };
      touch(session);
      ready.resolve(session.info);
      const code = yield* Effect.promise(() => process.exited);
      session.info = { ...session.info, exit_code: code };
    });
    session.done = (async () => {
      try {
        await Effect.runPromise(
          lifetime().pipe(Effect.scoped, Effect.timeout(limits.lifetimeMs)),
          { signal: session.abort.signal }
        );
      } catch {
        if (session.info.status === "starting")
          ready.reject(
            new ApiError("Could not start the development container", 502)
          );
        if (!session.abort.signal.aborted)
          session.reason = "Terminal ended or reached its one-hour limit.";
      } finally {
        if (session.idle) clearTimeout(session.idle);
        session.process = null;
        session.info = { ...session.info, status: "exited" };
        session.listener?.({
          type: "exit",
          code: session.info.exit_code,
          reason: session.reason,
        });
      }
    })();
    return ready.promise;
  };
  const close = async (owner: string, id: string) => {
    const session = owned(owner, id);
    session.reason = "Terminal closed.";
    session.abort.abort();
    await session.done;
    return session.info;
  };
  return {
    create,
    close,
    list: (owner: string) =>
      [...sessions.values()]
        .filter((s) => s.owner === owner)
        .map((s) => s.info),
    info: (owner: string, id: string) => owned(owner, id).info,
    ticket: (owner: string, id: string) => {
      const session = owned(owner, id);
      session.ticket = {
        value: crypto.randomUUID(),
        expires: Date.now() + 30_000,
      };
      return { ticket: session.ticket.value };
    },
    consumeTicket: (ticket: string): string | null => {
      for (const session of sessions.values()) {
        if (
          session.ticket?.value === ticket &&
          session.ticket.expires > Date.now()
        ) {
          session.ticket = null;
          return session.info.id;
        }
      }
      return null;
    },
    attach: (
      id: string,
      listener: (event: TerminalServerMessage) => void,
      disconnect: () => void
    ) => {
      const session = sessions.get(id);
      if (!session) {
        disconnect();
        return;
      }
      session.disconnect?.();
      session.listener = listener;
      session.disconnect = disconnect;
      listener({
        type: "ready",
        session: session.info,
        replay: session.buffer.read(),
      });
      if (session.info.status === "exited")
        listener({
          type: "exit",
          code: session.info.exit_code,
          reason: session.reason,
        });
    },
    detach: (id: string, disconnect: () => void) => {
      const session = sessions.get(id);
      if (session?.disconnect === disconnect) {
        session.listener = null;
        session.disconnect = null;
      }
    },
    receive: (
      id: string,
      message: TerminalClientMessage,
      connection?: () => void
    ) => {
      const session = sessions.get(id);
      if (!session?.process || session.info.status !== "running")
        throw new ApiError("Terminal has exited", 409);
      if (connection && session.disconnect !== connection)
        throw new ApiError("Terminal connection was replaced", 409);
      if (message.type === "input") {
        touch(session);
        session.process.write(message.data);
      } else {
        session.process.resize(message.cols, message.rows);
        session.info = {
          ...session.info,
          cols: message.cols,
          rows: message.rows,
        };
      }
    },
    closeOwner: async (owner: string) => {
      await Promise.all(
        [...sessions.values()]
          .filter((s) => s.owner === owner)
          .map((s) => close(owner, s.info.id))
      );
    },
    closeAll: async () => {
      await Promise.all(
        [...sessions.values()].map((s) => close(s.owner, s.info.id))
      );
    },
  };
};
