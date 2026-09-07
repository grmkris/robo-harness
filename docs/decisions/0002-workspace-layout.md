# 0002 — Workspace layout and an enforced import graph

## Status

Accepted, 2026-09-07.

## Context

The coordinator, workbench, CLI and shared contract all lived in one flat `src/`, so nothing declared or enforced which part could depend on which. The house style across the other repositories is an `apps/*` + `packages/*` workspace with the dependency rules stated once and checked.

## Decision

Split into `apps/{server,web,cli}` and `packages/{domain,protocol}`, each a workspace that exports its TypeScript source, with the Python service as a foreign graph node. `tools/graph.ts` states every import edge once; `tools/oxlint/boundaries.ts` turns it into a lint error in the editor and `tools/check-graph.ts` checks the whole-repository properties. The shared contract splits: value types to `@robo/domain`, Zod tool schemas to `@robo/protocol`. Tests run against processes started on port 0 through a shared harness, so there are no fixed ports and no sleeps.

## Consequences

Widening a boundary is a two-file change (the graph declaration plus a decision record), which a reviewer sees. Zod stays in `@robo/protocol` until the Effect Schema migration; the workbench will re-declare a dependency on `@robo/protocol` when it adopts the typed client.
