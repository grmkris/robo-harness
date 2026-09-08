# Visual joint exploration acceptance — 2026-09-08

Implementation: `ccd554b` (retain recent camera comparisons) and `76420c0` (permit bounded visual joint exploration). Architecture: [decision 0009](decisions/0009-visual-joint-exploration.md). Remaining geometry work: [commissioning](commissioning.md#two-independent-workflows-visual-exploration-and-cartesian-positioning).

## Automated checks and deployment

- `bun run check` passed, including 123 Bun tests and 82 Python tests. Existing transitional lint warnings, optional Python import warnings and dependency deprecations remain.
- The camera-context regression covers two mock joint probes and verifies that the model receives two, four, then six images with the associated measured observations. Older images are explicitly omitted without removing the active operator task. Separate coordinator and Python tests verify that uncommissioned Cartesian requests remain rejected while bounded joint requests are permitted.
- `bun run build` passed with the existing large Ghostty chunk warning. Restarted `robo-app` and `robo-rerun` after checking that no chat or operator held control; both services became active. The Python motor service and deployed geometry/profile were unchanged.
- An Expect browser check loaded the deployed workbench and verified that Stop/Hold remained visible. Result: `/tmp/expect-artifacts/playwright-results/result-ae9891fd.json`.

## Live Grok probe

The deployed coordinator ran `xai/grok-4.6` against the real `so101` backend. The request allowed at most one small single-joint probe, chosen by the model, after observing the joints and both cameras. It required measured completion, both camera views afterward and a concise experimental note. Scope excluded pickup, table approach, object closure, perception, shell execution and a second motion. A local monitor checked the motion count and imposed a four-minute deadline.

Conversation: `8fd5cbfd-611a-4599-a3fc-1f717b7e6ae8`. Run: `164fad8f-cb30-4a30-9a1b-625c8d379847`. Robot boot: `d0d64060-b918-4f3d-9131-d91f9ed37833`.

Grok observed the elbow at 98.2418 degrees, close to its 98.4176-degree upper limit, and cables across the mat. It chose a small opening of the unoccupied gripper instead of an arm-joint probe. Its stated hypothesis was a slightly wider jaw gap in the wrist view, with little workspace-view effect and no object movement.

- Exactly one motion: `move_joints`, target gripper 21.2%, duration 1 second. Initial measured gripper position was 20.218579%, so the requested change was +0.981421 percentage points.
- Operation `8a56bc48-ad79-4977-be23-258f05d17c64`, request `221634d4-5318-4ca5-bc9c-79bc5e36733d`, reached measured completion. At that instant the gripper measured 20.286885%, with a 0.913115-point target residual inside the configured 2-point gripper tolerance. This completion tolerance is larger than the probe and does not establish precise tracking of a one-point command.
- The subsequent observation measured 20.969945%: +0.751366 points from the initial reading, with all five arm joints unchanged. Grok distinguished this later reading from the completion sample.
- Both cameras were captured before and after. Workspace sequences: 1000798 and 1002130. Wrist sequences: 984170 and 985415. Frames were 640×480 and reported ages of 30–50 ms; camera calibration remained null.
- Grok reported no discernible change in either image, including the jaw gap, white piece, bin and cables. It recorded the sub-resolution effect as uncertainty rather than claiming visible progress. This is the model's comparison; the exact four image payloads are not persisted in chat history. Earlier local inspection frames are retained separately and are not substitutes for those capture IDs.
- No tool error or second motion occurred. At the end, no chat was running, ownership was released, no fault was reported and `cartesian` remained false.

The probe accepts the bounded observation/action workflow and accurate reporting of a small, visually inconclusive result. It does not establish grasp success, a learned arm-motion mapping, collision-free approach paths or Cartesian accuracy. The two-probe camera-retention scenario is covered by the automated fixture, not by an additional live motion.

Local evidence is under `var/visual-exploration-acceptance/`: `live-session.json`, `live-transcript.json`, `before-status.json`, `after-status.json`, and earlier local inspection frames. These runtime files remain uncommitted. No historical camera transform was imported and no commissioning flag was enabled.
