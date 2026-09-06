# Robo Harness

Standalone SO-101 playground. No runtime dependencies on Invok or the archived harness.

- TypeScript: Bun, React/Vite, custom AI SDK loop. Python: LeRobot I/O and Rerun.
- Run `bun run check`, `uv run --extra dev pytest`, `bun run build`.
- The user authorized real-arm deployment on 2026-09-06. Do not ask for another software activation approval. The user also confirmed the workspace is clear and authorized powered movement. Never silently recalibrate motors; retain small, bounded startup and commissioning motions.
- One motor owner. Preserve explicit units, control leases, bounded moves, measured completion, and idempotent request IDs.
- Human takeover revokes agent motion. Stop is always available to authenticated operators.
- Tailscale access is the default: no operator token or login prompt. Internal service credentials and controller ownership remain implementation details. Development workspaces cannot write deployed configuration.
- Keep inference, encoding, Rerun, and storage off the motor loop. Log dropped telemetry explicitly.
- Never print credentials, import credentials implicitly, expose services publicly, or auto-purchase compute.
- Test browser-facing changes with Expect.
