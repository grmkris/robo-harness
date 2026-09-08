# Elbow probe timeout — 2026-09-08

## Live evidence

In Qwen3.8-Max conversation `18b32fdd-5079-4277-be12-600ee5ccd93e`, a request to pick up the white piece produced an initial elbow probe from 98.241758 degrees to 97.24 degrees over 1.5 seconds. Operation `2dffbe6e-3619-45b9-9840-9e6817d8ca0a` failed with `Target did not settle before deadline`. The measured elbow angle remained unchanged, leaving a 1.001758-degree residual outside the 0.8-degree arm tolerance. The configured settling allowance is two seconds after the requested duration. This was an accepted joint command followed by failed measured completion, not a Cartesian commissioning rejection.

The model subsequently chose a shoulder-lift probe from -104.307692 to -103.31 degrees over two seconds. Operation `6428370c-58f7-4e38-93b5-b0b5e58910fa` completed at -103.604396 degrees; the later reading was -103.516484, a +0.791209-degree change. This demonstrates that actuation was not globally unavailable. It does not diagnose the elbow.

During investigation, Stop revoked the chat's motion authority and confirmed no controller, no fault and commanded hold. No further physical probe was sent by the investigator. Fresh workspace/wrist captures were inspected, but the elbow's contact surfaces were not sufficiently visible to rule out contact or cable tension.

## Confirmed coordinator bug and fix

On settling timeout the Python engine clears its lease. The coordinator then attempted normal release using that removed lease. Python correctly rejected it, but the coordinator appended an ambiguous ownership-cleanup warning even though control was already free.

The action finalizer now falls back to the existing boot-guarded, owner-specific cancellation endpoint when terminal release fails. That endpoint confirms cleanup without taking control, retrying motion, changing a terminal operation or releasing another owner's lease. A lost release reply follows the same reconciliation path. If both requests fail, the warning remains and renewal stays stopped. The actual motion failure is preserved.

Regression coverage includes timeout after lease removal, a lost release reply followed by human acquisition, an unreachable cleanup endpoint, and the real Python state machine's unresponsive-joint timeout. No motor-service implementation, completion tolerance, calibration, gains or motion limits were changed.

## Elbow diagnosis remains open

The deployed driver and engine hashes match this tree. The installed LeRobot driver writes joint goals through its ordinary position-command path with a two-degree relative cap. The 97.24-degree elbow request maps to raw goal 3130 using the deployed calibration; measured 98.241758 degrees maps to raw 3142.

The saved startup recovery evidence from September 6 (`/home/kris/robo-harness/var/startup-recovery-2.json` on the Pi) also records a raw goal of 3130 settling at 3142, after moving inward from 3147. Calibration registers were unchanged and torque was enabled then. The repeated residual is a useful clue, not proof of a particular cause. Small-command deadband, static load/servo response and physical contact remain possibilities. A software limit is not itself evidence of contact with a physical stop.

Do not label this a stalled or broken motor based on the angle alone, loosen completion tolerance to call it successful, silently tune gains, recalibrate, or continue a pickup sequence around the unexplained result. The next physical diagnostic depends on inspecting elbow clearance; current camera angles cannot establish that alone.

Local incident evidence is saved under `var/elbow-failure-2026-09-08/` (transcript, post-stop status, camera frames and metadata). Runtime artifacts remain uncommitted.

## Validation

`bun run check:fast` and `bun run check` passed, including 128 Bun tests and 83 Python tests. The focused action-executor suite passed all 17 cases. `bun run build` passed. Existing transitional lint warnings, optional Python import warnings, dependency deprecations and the large Ghostty build chunk warning remain.

The Expect chat checks passed against an isolated mock: model capability selection, invalid-input recovery, measured completion, released ownership, mobile Stop access and event replay. The first runner attempt omitted the extra text-only fixture model; adding it to the mock catalog allowed the existing checks to run. No paid model or real motor was used by this browser check.

## Operator-requested retry

After the operator said “go try again,” Qwen resumed the same conversation with fresh joint observations and both camera views. This turn permitted exactly one elbow-only diagnostic to 96.44 degrees over two seconds, approximately 1.8 degrees inward and within the existing two-degree bound. The initial chat-start request was rejected for an incorrect request field before any model run or motion; the corrected request resumed the intended conversation.

Operation `c8aaa478-3092-48eb-bcff-a91c8abdea5c`, request `ad08e9c5-8d93-4d0a-bdb4-f2d5d266c931`, failed its measured settling check. The elbow remained at 98.241758 degrees, with a 1.801758-degree residual. Every other measured joint was unchanged. The terminal response correctly omitted the former cleanup warning: the owner-specific fallback confirmed cleanup, control was free and the control epoch advanced from 8 to 9. No fault was reported. There was exactly one motion request in the retry turn, followed by observation and both cameras; no pickup or further probe followed.

Qwen reported no visible change. Its final explanation overstated the evidence by calling the calibration bound a mechanical limit and the software `commanded` field a motor register. Neither a hard-stop location nor the actual motor goal register was measured. An unchanged joint reading also does not establish whether the cause is a mechanical stall, disabled torque, controller response or readback failure. The next diagnostic should examine the elbow's torque-enable/error/current and actual goal/position registers through exclusive motor ownership, rather than infer those values from the coordinator observation.

Retry artifacts are under `var/elbow-retry-2026-09-08/`: full transcript, before/after observations and local before/after camera frames. No settings, calibration, gains or limits were changed.
