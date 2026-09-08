# 0007 — TanStack AI with Effect-owned execution

Accepted 2026-09-08. The operator chose TanStack AI after the comparative assessment. This decision supersedes that assessment's recommendation to retain Vercel.

Use pinned TanStack AI core and its OpenAI-compatible Chat Completions adapter for Alibaba and xAI. Preserve the runtime model allowlist, explicit vision policy, per-request xAI authentication, and zero provider retries. A narrow adapter subclass uses the documented request-mapping extension point to preserve optional, non-null tool inputs; TanStack’s automatic strict-mode widening is incompatible with this contract. Validation also checks original streamed arguments before adapter normalization. Raw SDK debug/error logging is disabled; the coordinator emits bounded, redacted domain errors. The workbench continues to consume the coordinator's domain events; provider-specific AG-UI chunks stay at the server boundary.

TanStack owns model turns, tool schema advertisement and tool dispatch. Effect owns the chat resource scope and streaming consumption, cancellation and cleanup. Effect Schema is the sole runtime validator, exposed through Standard Schema with excess-property rejection. A provider-only watchdog must not time out supervised tool execution.

Native middleware controls available tools, injects steering and camera observations, and enforces the shared turn budget and reserved final summary. Execution-time guards remain authoritative even if the model ignores tool availability. The supervised motion executor, action ledger, three-second lease and human takeover rules are unchanged.

Store versioned, decoded transcripts and translate existing Vercel transcripts when loaded. Never persist captured image bytes. Preserve durable chat/action events and make SSE replay idempotent.

Implementation gates: provider-wire fixtures (schemas, images, retries), loop/steering/cancellation tests, existing action integration tests, full repository checks, browser acceptance, then deployment and live provider acceptance. Activate only after these local gates pass.
