# Architecture

Robo Harness has three processes and one wire contract between them.

## Processes

- **Python motor owner** (`python/robo_harness`, `robo-io`). A FastAPI service on the Pi. One daemon thread is the single writer to the motors, under one lock, at 30 Hz. It owns the driver (mock or LeRobot/Feetech), the cameras (through the so101-lab `lab_cameras` owner), control leases, bounded moves, measured completion, idempotent request IDs, and fault latching. Camera JPEG encoding runs in per-camera threads, never on the motor loop.
- **TypeScript coordinator** (`src/server`, `robo-app`). A Bun HTTP server. It polls the motor owner at 10 Hz, holds the latest observation and per-owner lease state, authenticates callers, runs the agent chat loop over the Vercel AI SDK, records sessions to SQLite and disk, proxies the Rerun viewer, and serves the built workbench. It never touches the motors directly; every motion goes through the Python service.
- **Rerun telemetry worker** (`python/robo_harness/telemetry.py`, `robo-rerun`). A separate process that spawns the Rerun viewer bound to loopback and polls the coordinator's telemetry endpoint. It is off the motor loop by construction.

The React/Vite workbench (`src/web`) is a client of the coordinator only.

## Wire contract

`src/shared/contracts.ts` is the shared contract: the observation, operation, frame and lease shapes, and the tool input schemas. The coordinator validates tool input against it, the workbench and MCP server speak it, and the Python service produces observations that match it. It is decoded at each boundary, not trusted.

## Trust and deployment

Tailscale access is the default; human trust comes from the peer address, not a header. Development shells run in a hardened bridge-network container with a short-lived capability token and no hardware or provider credentials. The lab runs from the `robo-harness-deploy` git worktree (a checkout of a tagged release) with its data directory outside any checkout via `ROBO_DATA_DIR`; see `docs/real-arm-preflight.md`.

## Direction

The TypeScript side is converging on the house style used across `~/code`: Effect 4 for lifecycle, configuration, typed errors and boundaries, Effect Schema in place of Zod, and an `apps/*` + `packages/*` workspace layout with an enforced import graph. Decisions are recorded in `docs/decisions/`.
