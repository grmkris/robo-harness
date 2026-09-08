# 0009: Permit visual joint exploration independently of Cartesian commissioning

Accepted 2026-09-08. The operator requested both bounded observation/action learning with Grok and a path to commissioned Cartesian control.

## Problem

The chat prompt required the model to decline a joint-space pickup plan whenever grasp geometry or Cartesian commissioning was unavailable. This conflated a restriction on unverified XYZ commands with a restriction on learning through bounded joint motion. The motor owner and coordinator already supported joint actions while `cartesian` was false.

## Decision

Allow the model to choose small joint probes for an operator-requested exploration or manipulation task, without requiring the operator to supply each angle. Observe joints/limits and both cameras, state one small hypothesis-driven probe, wait for measured completion, observe both views again, and use the result to choose the next step. Start with one joint and at most one degree (one percentage point for the gripper), within all existing runtime limits. Report unclear effects and stop when visibility, clearance, control or motion outcome is uncertain. Every approach/grasp step requires current visual support; no blind multi-move pickup sequence is authorized by this workflow.

Retain concise experimental notes in conversation: requested and actual joint change, visible effect, uncertainty and next hypothesis. The provider context retains the six most recent images (three workspace/wrist pairs). Image payloads have their own bound instead of consuming the text-history character budget. Older image parts become explicit omission notices while metadata remains. Text trimming removes complete older operator turns, never treating a camera observation as a new operator task; it does not split the active turn. Captures remain available in the active model context within that window; persisted chat text does not contain image bytes. Recordings remain the separate durable camera/action evidence. These observations are local to the current pose and camera view, not calibrated XYZ geometry or newly trained model weights.

`cartesian=false` continues to block XYZ requests in both the coordinator and Python engine. `ee`, frame transforms and trajectory coordinates remain explicitly model-derived/uncommissioned until geometry is reviewed. Motor limits, rate/step bounds, path checks, leases, one-action admission, measured completion, human takeover and stop remain authoritative.

This supersedes the earlier blanket wording about automatic picking in decision 0008: segmentation does not commission metric grasp planning, but visually supported incremental joint exploration/manipulation can proceed independently.

## Cartesian work

Follow [commissioning](../commissioning.md). The older `so101-lab/gemini_er` experiment provides a board-detection and wrist-servo pattern, not a current reviewed transform. Its calibration is dated 2026-08-12, uses legacy camera indexes and lacks current mount identity. Its board registration fits the same samples it scores; its source also documents centimetre-scale command/position discrepancy. Revalidate camera geometry, gripper/tool frame, table reference and actual measured poses before applying its values or enabling XYZ commands.
