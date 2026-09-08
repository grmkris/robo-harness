import { TerminalServerMessage, TerminalSession } from "@robo/domain";
import { Schema } from "effect";
import type * as Ghostty from "ghostty-web";
import { useEffect, useRef, useState } from "react";

import { api } from "../lib/client";

let ghosttyReady: Promise<typeof Ghostty> | null = null;
const loadGhostty = () => {
  ghosttyReady ??= (async () => {
    const module = await import("ghostty-web");
    await module.init();
    return module;
  })();
  return ghosttyReady;
};
interface Controls {
  start: () => Promise<void>;
  close: () => Promise<void>;
  interrupt: () => void;
}
export const InteractiveTerminal = () => {
  const element = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLPreElement>(null);
  const controls = useRef<Controls | null>(null);
  const [status, setStatus] = useState("Loading terminal…");
  const [error, setError] = useState("");
  const [live, setLive] = useState(false);
  const [active, setActive] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    let terminal: Ghostty.Terminal | null = null;
    let socket: WebSocket | null = null;
    let session: TerminalSession | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let transcriptFrame: number | undefined;
    const updateTranscript = () => {
      if (transcriptFrame !== undefined) return;
      // ghostty-web 0.4.0 declares onRender but never emits it. Read the actual
      // terminal buffer after writes, coalescing chunks into one frame.
      transcriptFrame = requestAnimationFrame(() => {
        transcriptFrame = undefined;
        if (!transcript.current || !terminal) return;
        const buffer = terminal.buffer.active;
        const lines: string[] = [];
        for (
          let line = Math.max(0, buffer.length - 120);
          line < buffer.length;
          line += 1
        ) {
          lines.push(buffer.getLine(line)?.translateToString(true) ?? "");
        }
        transcript.current.textContent = lines.join("\n");
      });
    };
    const write = (data: string) => {
      // Its WASM allocator returns an invalid pointer for empty writes.
      if (!terminal || !data) return;
      terminal.write(data);
      updateTranscript();
    };
    const report = (failure: unknown) => {
      if (!disposed)
        setError(
          failure instanceof Error
            ? failure.message
            : "Terminal connection failed"
        );
    };
    const send = (
      message:
        | { type: "input"; data: string }
        | { type: "resize"; cols: number; rows: number }
    ) => {
      if (socket?.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    };
    const connect = async () => {
      if (disposed || !session) return;
      setStatus("Connecting…");
      const { ticket } = await api<{ ticket: string }>(
        `terminals/${session.id}/ticket`,
        {}
      );
      if (disposed) return;
      const url = new URL("/api/terminal/connect", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket);
      const next = new WebSocket(url);
      socket?.close();
      socket = next;
      next.onmessage = (message) => {
        if (disposed || socket !== next) return;
        try {
          const event = Schema.decodeUnknownSync(TerminalServerMessage)(
            JSON.parse(String(message.data))
          );
          switch (event.type) {
            case "ready": {
              session = event.session;
              attempts = 0;
              // Reset the emulated terminal without replacing the WASM buffer that
              // Ghostty's renderer and accessibility adapter reference.
              write("\u001Bc");
              write(event.replay);
              setActive(session.status === "running");
              setLive(session.status === "running");
              setStatus(
                session.status === "running"
                  ? "Connected · Netcup workspace"
                  : "Shell exited"
              );
              if (session.status === "running" && terminal) {
                send({
                  type: "resize",
                  cols: Math.min(240, terminal.cols),
                  rows: Math.min(100, terminal.rows),
                });
              }
              terminal?.focus();
              break;
            }
            case "output": {
              write(event.data);
              break;
            }
            case "exit": {
              if (session)
                session = {
                  ...session,
                  status: "exited",
                  exit_code: event.code,
                };
              setActive(false);
              setLive(false);
              setStatus(event.reason);
              write(
                `\r\n[${event.reason}${event.code === null ? "" : ` Exit ${event.code}.`}]\r\n`
              );
              break;
            }
            case "error": {
              setError(event.message);
              break;
            }
          }
        } catch (error) {
          report(error);
          next.close();
        }
      };
      next.onclose = (event) => {
        if (disposed || socket !== next || session?.status === "exited") return;
        setLive(false);
        if (event.code === 4001 || event.code === 1008) {
          setStatus("Disconnected");
          setError(event.reason || "Terminal connection closed");
          return;
        }
        if (attempts >= 5) {
          report(
            new Error("Connection lost. Reopen the Terminal tab to reconnect.")
          );
          return;
        }
        setStatus("Reconnecting…");
        attempts += 1;
        reconnect = setTimeout(
          () => {
            void connect().catch(report);
          },
          Math.min(8000, 500 * 2 ** attempts)
        );
      };
    };
    const initialize = async () => {
      const { Terminal: TerminalView, FitAddon } = await loadGhostty();
      if (disposed || !element.current) return;
      terminal = new TerminalView({
        fontFamily: '"IBM Plex Mono", monospace',
        fontSize: 12,
        cols: 80,
        rows: 24,
        scrollback: 1000,
        cursorBlink: true,
        cursorStyle: "bar",
        theme: {
          background: "#1a231e",
          foreground: "#d9e4d0",
          cursor: "#d4e6ab",
          selectionBackground: "#436045",
        },
      });
      terminal.open(element.current);
      terminal.textarea?.setAttribute(
        "aria-label",
        "Interactive terminal input"
      );
      terminal.onData((data) => {
        // Bound each frame without splitting a Unicode codepoint or replaying input.
        const characters: string[] = [];
        for (const character of data) characters.push(character);
        for (let offset = 0; offset < characters.length; offset += 4096) {
          send({
            type: "input",
            data: characters.slice(offset, offset + 4096).join(""),
          });
        }
      });
      terminal.onResize(({ cols, rows }) => {
        updateTranscript();
        if (session?.status === "running")
          send({
            type: "resize",
            cols: Math.max(2, Math.min(240, cols)),
            rows: Math.max(2, Math.min(100, rows)),
          });
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      fit.fit();
      fit.observeResize();
      controls.current = {
        start: async () => {
          if (!terminal) return;
          setBusy(true);
          setError("");
          try {
            session = Schema.decodeUnknownSync(TerminalSession)(
              await api("terminals", {
                cols: Math.max(2, Math.min(240, terminal.cols)),
                rows: Math.max(2, Math.min(100, terminal.rows)),
              })
            );
            if (!disposed) {
              setActive(session.status === "running");
              await connect();
            }
          } catch (error) {
            report(error);
          } finally {
            if (!disposed) setBusy(false);
          }
        },
        close: async () => {
          if (!session) return;
          setBusy(true);
          try {
            session = Schema.decodeUnknownSync(TerminalSession)(
              await api(`terminals/${session.id}/close`, {})
            );
            if (!disposed) {
              setActive(false);
              setLive(false);
              setStatus("Terminal closed.");
            }
          } catch (error) {
            report(error);
          } finally {
            if (!disposed) setBusy(false);
          }
        },
        interrupt: () => {
          send({ type: "input", data: "\u0003" });
          terminal?.focus();
        },
      };
      setReady(true);
      const existing = Schema.decodeUnknownSync(Schema.Array(TerminalSession))(
        await api("terminals")
      );
      if (disposed) return;
      session = existing[0] ?? null;
      if (session) {
        setActive(session.status === "running");
        await connect();
      } else {
        setStatus("Ready to start");
        write("Open a terminal to enter your development workspace.\r\n");
      }
    };
    void initialize().catch(report);
    return () => {
      disposed = true;
      clearTimeout(reconnect);
      if (transcriptFrame !== undefined) cancelAnimationFrame(transcriptFrame);
      controls.current = null;
      socket?.close();
      terminal?.dispose();
    };
  }, []);
  return (
    <section className="interactive-terminal" aria-label="Development terminal">
      <div className="terminal-toolbar">
        <output>
          <i className={live ? "terminal-dot live" : "terminal-dot"} />
          {status}
        </output>
        <div>
          {active ? (
            <>
              <button
                type="button"
                disabled={busy || !live}
                onClick={() => controls.current?.interrupt()}
              >
                Ctrl-C
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void controls.current?.close();
                }}
              >
                Close terminal
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={!ready || busy}
              onClick={() => {
                void controls.current?.start();
              }}
            >
              {busy ? "Starting…" : "Open terminal"}
            </button>
          )}
        </div>
      </div>
      <div className="terminal-screen" ref={element} />
      <pre ref={transcript} className="sr-only" aria-label="Terminal output" />
      <div className="terminal-footnote">
        <span>Files stay in your workspace.</span>
        <span>Closes after 10 min idle · 1 hour max</span>
      </div>
      {error ? (
        <p role="alert" className="terminal-error">
          {error}
        </p>
      ) : null}
    </section>
  );
};
