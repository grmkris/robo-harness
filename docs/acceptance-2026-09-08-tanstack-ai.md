# TanStack AI adoption acceptance — 2026-09-08

Decision: [0007](decisions/0007-tanstack-ai-effect.md). Implementation: `6c2e774`; event replay: `0fa357a`.

## Implemented and deployed

- TanStack AI 0.53.0, its OpenAI adapter 0.22.5 and the pinned OpenAI transport 6.49.0 replace all Vercel SDK runtime dependencies.
- Effect scopes own stream cancellation, iterator cleanup and provider deadlines. Supervised actions receive scope cancellation and retain their existing lease, measured-completion and human-takeover safeguards. Shutdown waits for chat cleanup before closing storage.
- Effect Standard Schema validates tool inputs. A supported adapter subclass preserves optional, non-null arguments on the provider wire; original streamed arguments are checked before TanStack normalization can erase a bad value. Provider retries and raw SDK error logging are disabled.
- Native middleware owns tool availability, steering, images, the shared step budget and the reserved summary. The workbench consumes domain events with durable SSE IDs and duplicate-delta protection.
- Stored conversations use a decoded versioned format. Legacy messages translate on read; unresolved historical tool calls receive an explicit unknown-outcome result and cannot automatically execute. Camera bytes never enter the stored transcript.

## Verification

The final full gate passed 108 Bun tests and 78 Python tests, plus format, lint, type, dependency and graph checks.

The full repository gate uses `TMPDIR=$PWD/var/test-tmp bun run check`. The shared `/tmp` volume fell below the recording service's 512 MiB reserve during testing; this location supplies adequate storage without weakening that safeguard or deleting unrelated work.

Coverage includes provider schemas and optional defaults, null/string/excess-property rejection, tuple conversion, zero HTTP retries, image delivery, dynamic discovery, steering, summary limits, provider stalls, long tool execution, cancellation, early consumer exit, takeover, single-action enforcement, legacy persistence and SSE reconnection. Private-history continuation is exercised through the real coordinator against a local provider fixture, including a pending historical motion and a malformed stored version.

`bun run build` passed. The final committed mock deployment passed `scripts/browser_check.py` with `ROBO_BROWSER_CHAT_ONLY=1`: tokenless access, model capability changes, validation recovery, coalesced measured-motion progress, mobile Stop controls and exactly-once draft updates under replay. Screenshot: `var/real-arm-acceptance/tanstack-browser.png` (local artifact).

The approved software promotion restarted `robo-app` and `robo-rerun`; both are active.

## Live Qwen motion

Conversation `83438203-9ac2-4aa3-b5c6-6999878f6755`, run `c768b9ff-78dd-444a-af1f-4335a4f89ef0`.

The deployed Qwen3.8-max used exactly `observe` followed by one `move_joints`. It completed in 45.703 seconds across three model steps, with zero invalid inputs, zero tool errors and one completed action. No camera capture, manual acquire/renew or retry occurred.

Gripper target: 13.8852%; measured before: 11.885246%; settled after: 13.661202%. All five arm joints stayed unchanged. The operation completed, ownership was released and no fault or active chat remained.

The operation's completion snapshot recorded a 1.043670-point gripper residual. Qwen relayed those numbers but incorrectly treated the nonzero residual as an acceptance failure. Independent inspection of `python/robo_harness/engine.py` confirmed the existing completion tolerances: 2 points for gripper and 0.8 degrees for arm joints, after the trajectory ends. The completion snapshot was within tolerance; the later settled residual was 0.223998 points. Motor behavior and tolerances were not changed for this migration.

Evidence: `var/real-arm-acceptance/tanstack-motion.json` (local, uncommitted).

## Restricted live checks

Automatic approval review rejected sending a current workspace image to Alibaba/Qwen without explicit data-transfer approval. The image approval question remains pending. It also rejected resending existing private conversation text for a separate live-history check. Neither rejected check ran; local image and persistence fixtures provide their automated coverage. The authorized live motion check transferred only its new prompt and observation/action results, with camera tools explicitly prohibited in the request.
