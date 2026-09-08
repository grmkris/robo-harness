# 0004 — Supervise chat motion inside the coordinator

Accepted 2026-09-08. Implements the [agent tool review](../review-2026-09-08-agent-tools.md).

## Problem

Model inference takes longer than the motor service's three-second lease. Exposing acquisition, movement and renewal as separate chat tools makes ordinary reasoning delay a control failure. The AI SDK also executes tools from one response concurrently. A dependent batch therefore cannot implement a motion transaction.

## Decision

Keep manual controls, MCP and programmatic clients on the existing low-level protocol. Chat gets `observe`, `capture`, `move_joints`, `stop` and `discover_tools`. Recording, budgeted perception, development programs and commissioned Cartesian motion become available on the next step after discovery. Availability is enforced during execution, independently of what the provider advertises or calls. A response can execute one side-effecting action; extra actions are rejected, never queued. Stop bypasses admission.

`motion-actions.ts` supervises one bounded action with an Effect scope. It obtains a fresh observation, checks limits and control availability, journals a stable request identity and payload, acquires agent ownership without takeover, starts explicit renewal immediately, submits once, and polls for measured completion. Renewal runs every 500 ms and only within the duration plus a five-second supervisory deadline. The Python owner retains its independent three-second lease, bounds, duration/speed checks, lock and motor loop.

The Python observation carries a boot ID and control epoch. Guarded acquisition compares both under the motor lock. Stop, human/leader acquisition, takeover and scoped cancellation invalidate stale acquisitions. Cancellation is registered before acquiring; a late acquire cannot resume after its cancellation. Coordinator stop/takeover also aborts all earlier chat turns. Ownership loss never causes automatic reacquisition. Cleanup addresses the action's own owner and boot; it preserves another human's lease.

An accepted operation is not a completed one. The result reports `completed`, `cancelled`, `failed` or `unknown`, original request/operation IDs, target, measured pose, residual and reason. Terminal operation evidence is captured by the motor owner and remains unchanged after later moves. Feedback is coalesced in the UI by action ID.

The SQLite action ledger is additive. Lost submission replies are reconciled by original owner/request/boot, without requiring a live lease and without resubmitting. A journaled pending or unknown action is never replayed after coordinator restart. An unknown result disables subsequent motion for that chat turn. An operator can inspect the robot and explicitly begin another turn; the system does not infer that a newly requested move is a retry.

## Model interface

Effect Schema input defaults use optional missing keys without advertising nullable values the decoder rejects. Numbers and booleans remain strict through HTTP and Python. Joint and Cartesian chat tools have separate schemas; empty joints and unknown properties are rejected. Concrete JSON examples are included in tool descriptions because the compatible adapter does not forward native examples. Malformed arguments produce an actionable, bounded error; they are never silently coerced, clamped, or converted into another ownership request.

Capabilities are resolved for the provider, endpoint and selected model. Documented direct-image support is enabled on recognized Alibaba/xAI endpoints; unknown endpoints require explicit model configuration. `ROBO_<PROVIDER>_VISION_MODELS` lists additional image models. Legacy `_VISION=1` applies only to the default model; `_VISION=0` explicitly disables images for all models. No vision fallback is silently purchased or selected. Strict generation remains unverified/disabled. Compatible providers receive `parallel_tool_calls: false` where supported, and coordinator admission still enforces behavior if ignored.

The loop counts failed steps independently of changing call IDs. Three failures, repeated calls, cycles or the total step budget trigger a reserved summary with execution disabled. Steering continuations share the original budget. Tool events retain call ID, run ID, step, validated input or redacted validation error, and elapsed time. Turn completion records duration, model steps, tool calls, malformed inputs, completed actions and first-call input validity. Images and provider errors containing request material are excluded from durable transcripts/events.

## Consequences and rollout

The runtime keeps leases out of model reasoning while retaining deliberate renewal and expiry. A process/network failure still terminates renewal; the Python owner holds its last commanded pose at expiry. If cleanup or reconciliation cannot be confirmed, the result says so. There is no automatic motion retry, background agent control, longer lease, new calibration, or robot framework dependency.

Deploy the guarded Python service before starting the new coordinator. Chat refuses movement against an older motor service without `control_epoch`. Low-level clients remain compatible. Existing explicit `_VISION=0` settings continue to disable images and should be reviewed when enabling a documented image-capable model.

Acceptance covers model delays, malformed primitives, duplicate/dependent calls, lost replies, cancellation during acquisition/submission/motion, renewal failure, takeover, deadline expiry, unreachable service, restart replay protection, strict Python inputs, terminal snapshots and summary enforcement. Browser checks use a scripted provider and mock motor service. Provider/account behavior and physical operation require separate deployed acceptance; offline fixtures do not establish either.
