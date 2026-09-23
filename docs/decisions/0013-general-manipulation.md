# General manipulation through the supervised executor

2026-09-23

The chat loop now exposes task-independent TCP motion, contact descent, wrist roll, gripper, home, look/crop and open-vocabulary locate. General embodiment and manipulation documents are loaded for every model. Task fixtures and scoring stay outside that prompt and tool layer.

Coordinator geometry is in config/manipulation.lab-pi.json, separate from the motor owner's reviewed profile. It is disabled until TCP, safe polygon and home are commissioned. The configuration is snapshotted at chat start. Native robo-io Cartesian control remains independently gated; TCP tools solve into small joint steps, still checked by every robo-io guard.

Each multi-step tool reserves admission in the shared motion executor, so other chat or decision actions cannot interleave. Each physical step has its own idempotent ledger entry and guarded three-second agent lease, measured polling, renewal and cleanup. Human takeover and Stop still revoke the run. A stale camera returns a transient error; the tool never switches lease mode or retries its failed step. Unknown and non-protective cancelled outcomes disable further chat motion.

Before each move, fresh observations, camera feedback and servo temperatures are checked. TCP targets, the planned straight path and individual joint endpoints must stay in the safe polygon/radius and above the table. A descent terminates at the first failed motor operation. Contact is a non-settling-motion inference, never proof of what was touched; gripper resistance likewise needs visual verification.

Look crops source pixels in software and returns their inverse mapping. Locate uses the existing budgeted SAM-3 perception path and source frame identity; table homography estimates carry a warning about raised-surface parallax. Unavailable segmentation returns the current image for model reasoning without inventing a metric location.
