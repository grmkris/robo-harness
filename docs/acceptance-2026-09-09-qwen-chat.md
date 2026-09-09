# Qwen, saved camera captures, and wrist motion acceptance

Date: 2026-09-09

## Software

- `a65620f`: decode Qwen reasoning chunks so an active thinking stream does not trip the silence watchdog; distinguish an actual timeout from another provider failure without exposing raw provider errors or retrying.
- `d6e4ec5`: save exact capture bytes and display them inline in chat, group tool calls/results, show measured motion details, simplify the workbench, and keep Stop / Hold visible while scrolling.
- Follow-up: flush assistant explanations before their tool call so new conversations retain the order in which the model generated them. Existing saved events are preserved.

The coordinator and Rerun worker were restarted after confirming no running chats, recording, controller, motion, or fault. The motor service was not restarted; boot ID remained `65fe5549-f59b-412c-a931-a9659f463aa8`.

## Live Qwen run

Conversation `43feef05-d46d-40a9-a08a-efe8eca0160c`, run `e9163450-eefc-4106-bec2-f8d0a5d47ff6`, model `qwen3.8-max` through Alibaba Token Plan. The request allowed exactly one wrist-roll probe of at most +1°, with observations and both camera views before and after. No pickup, other joint motion, perception, shell command, or settings change was requested or performed.

Qwen completed eight model steps and seven tool calls in 66.1 seconds, with zero invalid inputs or chat errors. Thinking activity was visible. The four captured images were saved and retrieved through the authenticated image endpoint with matching `X-Frame-Id` headers.

| Wrist roll               |   Degrees |
| ------------------------ | --------: |
| Initial measured         | −2.945055 |
| Requested target         | −1.945055 |
| Final measured           | −2.417582 |
| Actual measured movement | +0.527473 |
| Residual to target       |  0.472527 |

The 1.5-second operation `7b31d573-0816-4cf5-9cae-c91a02781916` completed inside the existing 0.8° tolerance. Request ID: `403fd13e-89b9-4405-9753-9686e4e1bf0c`. Every other measured joint was unchanged. Control was released, no fault was reported, and Cartesian commissioning remained false.

This confirms a small physical wrist response. It does not prove the health of every joint, resolve the earlier elbow failure, or demonstrate a grasp. The camera pairs show a subtle wrist-view change and no obvious object displacement; the numerical movement comes from encoder feedback, not an image-derived angle measurement.

| View | Before frame sequence | After frame sequence | Saved image IDs |
| --- | --: | --: | --- |
| Workspace | 55864 | 56591 | `cd2f9f0c-6d2f-4790-92f0-c05752210ad4`, `034d7185-defc-4e71-8ea9-5a4f6f15f58a` |
| Wrist | 56682 | 57626 | `62001192-709a-481d-ae5f-9e148998f62d`, `d0679138-b834-472c-a97a-b9ea459c1cec` |

Each frame was 640×480 and 20–51 ms old at capture. Local acceptance artifacts are in `var/qwen-ux-acceptance-2026-09-09/`: before/after status, transcript, and the exact four capture JPEGs.

## Checks

`bun run check` passed all checks: 132 Bun tests and 83 Python tests. `bun run build` passed. Existing lint, optional Python dependency, and large Ghostty bundle warnings remain.

The Expect mock browser checks passed model selection, invalid tool input recovery, measured motion, four inline before/after images, exact image URLs after reload, grouped calls/results, a narrow-screen layout with sticky Stop / Hold, assistant explanation ordering, SSE replay deduplication, and retention of earlier captures through 300 streamed deltas. A live read-only browser check loaded all four original 640-pixel images, verified the wrist result table and report, and found zero chat errors. Screenshot: `/tmp/expect-artifacts/screenshot-1788939487363.png`.

See [decision 0010](decisions/0010-chat-observations.md) for persistence and stream behavior, including the limits of attributing the earlier unrecorded provider stall.
