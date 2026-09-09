# 0010 — Saved camera observations and chat activity

Date: 2026-09-09

## Decision

A camera capture in chat stores its exact bytes in a separate SQLite `chat_images` row, linked to the conversation and source frame ID. The tool result carries an image ID and capture metadata. An authenticated endpoint serves the saved image; event and model-history JSON never contain its base64 bytes. A reopened conversation displays the original capture, never the current live camera. Older captures without saved pixels say so explicitly. Text-only models still produce operator-visible captures without receiving image input. Recording frames are marked as historical.

The active model context continues to receive the bounded recent-image window. Persisting images for the operator does not restore them into later model turns or imply that an old image is fresh enough for motion.

Qwen's `reasoning_content` field is decoded at the OpenAI-compatible adapter boundary and forwarded through TanStack's reasoning lifecycle. The existing provider watchdog therefore observes reasoning activity while retaining its 90-second silence limit. Only the thinking status reaches the UI, not the reasoning text. Actual provider silence is reported separately from a generic provider failure, without exposing raw errors or retrying a request.

The workbench groups tool calls with their results, exposes measured motion details, and keeps Stop / Hold in the sticky top bar. Text deltas update the draft without evicting earlier observations from the visible event list. Branding and introductory slogans give way to the working controls.

## Validation

The provider regression uses reasoning-only SSE chunks spanning more than the test silence deadline, followed by visible text. Existing tests still verify cancellation on real silence and exclusion of tool execution time from provider deadlines. Integration tests compare saved image bytes with the image sent to the model, check historical retrieval and authentication, and cover text-only captures. Expect checks cover inline before/after images, reload persistence, grouped tool results, measured positions, and the sticky stop control on mobile.

Alibaba documents reasoning chunks in [streaming output](https://www.alibabacloud.com/help/en/model-studio/stream) and [deep thinking](https://www.alibabacloud.com/help/en/model-studio/deep-thinking). The earlier 90-second production failure did not retain raw provider chunks, so reasoning suppression is a reproduced integration defect, not proof of that request's exact network behavior.
