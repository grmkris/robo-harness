# 0011 — Decision runner for evaluation-model action selection

Accepted 2026-09-17. Implements the SO-101 lab brief "Proposed experiment — Jev CLI" (myplan 00 Overview), integrated into the coordinator by the operator's choice instead of an external CLI loop.

## Problem

The experiment asks whether an evaluation model — TypeSafe's Jev (`typesafe-ai/jev`) through Vercel AI Gateway — can pick the next useful action for the real arm while existing controllers enforce every limit. Jev is not a chat model: it answers typed Choice/Score/Boolean questions about text or JSON state, through the AI SDK `experimental_evaluate` API only. An external loop over `/api/tool/*` would re-implement acquisition, renewal and completion polling, and it meets the 250 ms cached-observation gate on most calls from netcup. The coordinator already has a supervised executor with a ledger, reconciliation and Stop/takeover aborts.

## Decision

`apps/server/src/decision/` runs one loop per run: observe (`motionIO.observe`, transport included) → optional text perception → decide → validate locally against a fresh observation → execute through the **same executor instance chat uses** → observe the measured outcome → log. One decision and at most one motion are outstanding. Chat and decision runs exclude each other; only one decision run exists at a time.

- **Candidates are built in code.** Complete bounded joint steps (≤2°/% and ≤2 units/s, inside commissioned limits), plus reobserve, wait, stop and done. Motion is offered only when the observation is usable (fresh, no fault, cameras fresh, nothing in progress). Cartesian is never offered.
- **Strategies share state and candidates.** A: one Choice over candidate IDs. B: parallel questions (terminate, act, joint, direction) composed into one offered step; anything unmapped becomes reobserve. C: the rules baseline proposes and Jev booleans may veto a motion or a "done"; a veto is reobserve, never a different motion. Rules: the baseline itself.
- **Model calls.** `ai@7.0.105` pinned, `maxRetries: 0`, zero data retention requested, a hard deadline that interrupts the request so late answers cannot be used, strict validation of choices and distributions, and distinct failures: missing key, authentication, billing, model access, rate limit, timeout, invalid answer, budget. Fatal failures end the run. A persistent SQLite meter caps cumulative spend (`ROBO_JEV_BUDGET_USD`, default 10) using the public Gateway catalog rate.
- **Safety.** Dry-run never calls the executor. The executor re-validates, journals and never replays an unknown outcome; an unknown outcome ends the run. Two consecutive failures end the run. Stop/takeover abort through `agentControlSignal`. On the `so101` backend, `execute` requires a human principal, `supervised: true` and at most 20 steps / 60 s. Probabilities are logged for analysis only.
- **Perception is text.** The pickup task adds a local wrist-camera white-blob detector (image offsets, labelled uncalibrated), a gripper stall check, and optionally a scene description from a vision model through an OpenAI-compatible endpoint (cliproxy by default). Images never reach Jev. Task completion requires converging evidence.
- **Evidence.** `decision.*` events in the existing event log and one JSONL per run under `ROBO_DATA_DIR/decision-runs/` with observation IDs and freshness, candidates, answers and distribution, verdict, request/operation IDs, measured change and residual, latency, cost and configuration.

`bun run jev` is a thin client (`--smoke`, `--observe`, `--fixtures`, `--dry-run`, `--execute`, `--status`, `--cancel`) that follows events over SSE and cancels on Ctrl-C.

## Consequences

Model-driven motion now has two entry points, both through one admission point. The coordinator environment must carry `AI_GATEWAY_API_KEY` (and a scene key when scene description is used); nothing is imported from other files. A 10 Hz stream mode (strategy D) needs a separate motor-owner decision; it is not part of this one. Offline fixtures and mock hardware establish plumbing, not Jev's physical competence; the pickup rules baseline has no image-to-joint mapping yet and only reobserves.
