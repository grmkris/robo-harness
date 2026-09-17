# 0012 — Stream control mode

Accepted 2026-09-17. Left open by [0011](0011-decision-runner.md), which noted that a continuous mode "needs a separate motor-owner decision".

## Problem

Every agent motion is an operation: one bounded step, planned, validated, polled to completion, reconciled in the ledger. That is the right shape for a decision the operator may have to audit, and the wrong shape for a closed loop. A visual-servo correction of a centimetre takes five or six operations, each with its own round trip, and between them the arm stops. The skills that centre and descend spend most of their time in that overhead, and the motion the cameras see is a stutter rather than a move.

A leader arm already drives the follower continuously, so the motor owner can follow a moving target — but that path reads a physical leader on the robot host and refuses remote targets.

## Decision

A fourth lease mode, `stream`, alongside `human`, `agent` and `leader`.

- `POST /control/stream {lease_id, owner, target}` sets an **absolute setpoint**, which replaces any previous one. It promises nothing about arrival, so there is no operation, no request ID and nothing to reconcile.
- The motor tick rate-limits `commanded` toward the newest setpoint at the profile's `max_speed`, so the per-tick step is bounded by the same limit an operation is bounded by.
- **The command may lead the measured position by at most one `max_step`.** That lead is the point, not a side effect: these servos settle a few tenths of a degree short of any small goal, and a stepped command re-planned from the measured position each time never accumulates enough error to overcome a joint's own friction. On 2026-09-17 `shoulder_lift` failed to follow 30 of 34 bounded steps raising the arm, which left the search sweeping blind 3.5 cm above the mat. Bounding the lead is what keeps a joint that finally breaks free from lurching.
- **Geometry is validated every tick.** A candidate that fails is dropped and the arm holds its previous command, with the reason surfaced in `observe().stream.rejected`. It does **not** latch a fault: a stream is a stream of intentions and one bad intention must not end the session, where a rejected _operation_ is a decision someone should see.
- **A setpoint older than 300 ms is not followed** and the arm holds. A controller that dies mid-move stops the arm without waiting for the 3 s lease to expire.
- A setpoint also renews the lease, so a 10 Hz controller needs no separate renew.
- `submit` is refused under a stream lease, as it is under a leader lease, so the two motion paths can never fight. Stopping, a takeover or a released lease clears the setpoint, so a new controller never inherits one.
- The camera-freshness guard that covers `agent` covers `stream` too.

## Consequences

Stream mode has no ledger and no measured-outcome record per intention, which is exactly why it is not the default: an auditable bounded step stays the shape for anything a person or a model decides deliberately. It is for code-owned closed loops — centring, descending, and a future 10 Hz teleop — where the _loop_ is the thing under review and the motor owner still enforces speed, limits, geometry, freshness and stop.

The coordinator must keep posting setpoints at 10 Hz or better or the arm will hold every 300 ms, which is a usable failure: it is slow, not unsafe.
