# 0006 — Interactive development terminal

Accepted 2026-09-08.

## Context

The workbench's command form could run `python --version`, but it did not provide a TTY, interactive Python, terminal editing, persistent shell state, or streamed output. Invok already pairs Bun PTYs with `ghostty-web`; Robo Harness can use that pattern while retaining its own container boundary.

## Decision

- Use Bun 1.4.2's `Bun.Terminal` (introduced in [Bun 1.3.5](https://bun.com/blog/bun-v1.3.5)) and [ghostty-web 0.4.0](https://github.com/coder/ghostty-web), as installed in Invok. No runtime dependency on Invok. The [Bun process API](https://bun.com/docs/runtime/child-process) and installed types define PTY behavior.
- The host PTY is a raw transport for `docker run --interactive --tty`. Bash lives inside the existing hardened development image: unprivileged UID, dropped capabilities, no privilege escalation, resource limits, bridge networking, only the controller's workspace mounted. No deployed configuration, motor devices, Docker socket, or provider/service credentials enter the container.
- Give each session its own program capability, revoked on exit. Closing also releases any control lease owned by that program. The existing three-second deliberate-renewal rule still applies to programs; opening a shell does not acquire or renew robot control.
- Effect acquire/release scopes own launch, cancellation, process cleanup and absolute timeout. Keep at most four sessions, one per browser controller. Expire at ten minutes without input or one hour total. Docker also runs the shell under an independent timeout so a coordinator crash cannot leave an indefinite session. Close/logout/shutdown remove the container; workspace files survive.
- HTTP creation/list/ticket/close routes require an authenticated human. A same-origin WebSocket consumes a one-use, thirty-second ticket; it never puts long-lived credentials in a URL. Tailnet trust still comes from the socket peer. Ownership checks protect every session route; attaching a new socket replaces the old writer.
- Decode dimensions and tagged input/output messages with shared Effect Schemas. Bound dimensions, input frames/rate, replay history (128 KiB), and WebSocket backpressure (1 MiB, including JSON expansion). Decode streaming UTF-8 and redact capability text even across PTY chunks. Persist lifecycle metadata, not terminal transcripts, in the event store.
- Reattach to the same process after tab changes or short disconnects. Replay output only; never retry keystrokes. Replay is a bounded byte history, not a full terminal checkpoint, so an application using older screen state may need a redraw.
- Lazy-load Ghostty on opening the Terminal tab. Ignore empty writes because 0.4.0's WASM allocator rejects them; use a VT reset before replay without replacing Ghostty's referenced buffer. Maintain an accessible text view from the actual terminal buffer after writes, because 0.4.0 declares `onRender` but never emits it.
- Keep the one-shot runner under a disclosure. Interactive access initially targets Netcup; Pi remains the existing separately provisioned development-account command path.

## Verification

Regression coverage exercises schema rejection, Docker isolation arguments, real Bun PTY shell state/resize, output replay, Unicode and split-token redaction, ownership and one-use tickets, stale connections, slot reservation during launch, cancellation while acquiring, idle cleanup and absolute deadlines. HTTP tests refuse agent credentials, bad dimensions and foreign origins.

`ROBO_BROWSER_TERMINAL_ONLY=1 ROBO_BROWSER_URL=<mock fixture URL> python3 scripts/browser_check.py` exercises the real Docker-backed terminal through Expect: TTY detection, Python REPL, Ctrl-C, reconnect with shell state, mobile resize, and explicit close. The fixture uses mock robot I/O; no inference or real motion is required. Expect's daemon state is isolated from other projects' browser sessions.
