# Architecture

Robo Harness has three processes and one wire contract between them.

## Processes

- **Python motor owner** (`python/robo_harness`, `robo-io`). A FastAPI service on the Pi. One daemon thread is the single writer to the motors, under one lock, at 30 Hz. It owns the driver (mock or LeRobot/Feetech), the cameras (through the so101-lab `lab_cameras` owner), control leases, bounded moves, measured completion, idempotent request IDs, and fault latching. Camera JPEG encoding runs in per-camera threads, never on the motor loop.
- **TypeScript coordinator** (`apps/server`, `robo-app`). A Bun HTTP server. It polls the motor owner and each camera independently at 10 Hz, holds the latest observation and per-owner lease state, authenticates callers, runs the agent chat loop with TanStack AI inside Effect scopes, records sessions to SQLite and disk, proxies the Rerun viewer, and serves the built workbench. It never touches the motors directly; every motion goes through the Python service.
- **Rerun telemetry worker** (`python/robo_harness/telemetry.py`, `robo-rerun`). A separate process that spawns the Rerun viewer bound to loopback and polls the coordinator's telemetry endpoint. It is off the motor loop by construction.

The React/Vite workbench (`apps/web`) is a client of the coordinator only.

## Wire contract

The shared contract now lives in `packages/domain` (value types) and `packages/protocol` (tool schemas and the typed client): the observation, operation, frame and lease shapes, and the tool input schemas. The coordinator validates tool input against it, the workbench and MCP server speak it, and the Python service produces observations that match it. It is decoded at each boundary, not trusted.

## Trust and deployment

Tailscale access is the default; human trust comes from the peer address, not a header. Development shells run in a hardened bridge-network container with a short-lived capability token and no hardware or provider credentials. The lab runs the systemd units from this `main` working tree (no worktree or deploy branch); real config and the provider credentials live in `~/.config/robo-harness.env` so the repo `.env` stays dev/mock, and data lives outside the repo via `ROBO_DATA_DIR`. See `docs/real-arm-preflight.md`.

## Direction

The TypeScript side is converging on the house style used across `~/code`: Effect 4 for lifecycle, configuration, typed errors and boundaries, Effect Schema in place of Zod, and an `apps/*` + `packages/*` workspace layout with an enforced import graph. Decisions are recorded in `docs/decisions/`.

Observation and frame freshness includes a conservative full HTTP round-trip bound plus elapsed local monotonic time. A camera request never blocks the observation sampler or the other camera; each camera has at most one request in flight. Recordings and telemetry read aged frame snapshots, and a robot boot change discards frames from another clock domain.

## Chat actions

Chat uses a small capability-gated facade over the low-level protocol. A coordinator action executor owns acquisition, bounded renewal, measured polling, cancellation and cleanup inside one Effect scope. Python boot/epoch guards reject stale acquisitions after stop or takeover, and an additive SQLite ledger prevents automatic replay after uncertain submissions or restart. The motor lease remains three seconds; manual controls and program clients retain the low-level API. See [decision 0004](decisions/0004-supervised-chat-motion.md).

## Interactive development terminal

The workbench lazy-loads Ghostty's WASM terminal emulator and connects to a coordinator-owned Bun PTY over an authenticated WebSocket. That PTY transports `docker run -it`; the shell runs in the same restricted development image and workspace as one-shot commands. Effect scopes own process cleanup, capability revocation and control release. Reconnecting restores a bounded output history and the existing shell; it never resubmits input. See [decision 0006](decisions/0006-interactive-development-terminal.md).

## Agent runtime

TanStack owns the model/tool cycle behind a server-only domain event adapter. Effect scopes own each stream, provider deadlines and cleanup; Effect Schema validates tool inputs without coercion. Versioned transcripts translate older conversations and close unresolved historical tool calls without executing them. See [decision 0007](decisions/0007-tanstack-ai-effect.md).

## Recording derivatives and perception

Catalog adapters connect SAM 3 masks and Depth Anything V2 relative-depth previews through a scoped fal queue request. Recording v2 timestamps observations before disk I/O, drains a bounded event writer, and preserves originals when creating MP4 or native LeRobot interval exports. Offline export process groups are owned by Effect and receive no provider credentials. See [decision 0008](decisions/0008-perception-and-recording.md) and [recording workflow](recordings.md).
