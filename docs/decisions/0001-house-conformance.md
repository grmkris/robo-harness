# 0001 — Converge on the house style, phased

## Status

Accepted, 2026-09-07. In progress.

## Context

Robo Harness was built quickly and correctly for a live demo, but diverged from the conventions shared by the other repositories on this machine: no Effect, Zod instead of Effect Schema, Prettier instead of Oxlint/Oxfmt, a loose `tsconfig`, a flat `src/` with no enforced import graph, and a single large request handler and workbench file. A review also found real safety, security and correctness defects in the coordinator, and four in the Python service.

## Decision

Bring the repository to full house conformance in phases, every commit green and deployable, driving the live arm to verify at each promotion. Isolate the live deployment first (a `robo-harness-deploy` worktree, data outside the checkout). Ship the cheap, live-relevant safety and security fixes before the larger refactor. Then the toolchain, the workspace layout and import graph, the Effect migration (services, config, typed errors, Effect Schema, house-style MCP with a stdio bridge), the remaining coordinator fixes, the Python bar, and deployment/CI.

Stay standalone: no runtime dependency on Invok or the archived harness. Keep the Vercel AI SDK, adopting the house loop shape (`stopWhen`, recovery middleware, a stub model for keyless tests). Keep SQLite on `bun:sqlite` behind a service.

## Consequences

`oxlint.config.ts` carries a transitional block downgrading to `warn` the rules that only fire on code the migration rewrites; each returns to `error` as its files are rewritten. The workbench flake in the current fixed-port integration tests is accepted until the port-0, event-predicate harness replaces it.
