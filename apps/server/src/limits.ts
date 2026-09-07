/**
 * The chat loop's hard numbers, in one place so the harness bar, the stop
 * conditions and the loop quote the same values the loop enforces. Nothing
 * here reads the environment; a caller that wants different caps passes them
 * through `runChatLoop`'s options.
 */

/** Steps per turn. A product cap, not a model limit: past this the turn ends
 *  and the operator decides whether to continue with another message. */
export const STEP_CAP = 24;

/** Runaway completion cap — not a UX limit. An agent turn that reasons about
 *  motion and writes small programs needs more headroom than a chat template. */
export const MAX_OUTPUT_TOKENS = 32_768;

/** Bound a hung provider stream — the raw one, through `stall-watchdog.ts`,
 *  never the SDK's `timeout`: that one runs over the composed step stream, so
 *  a tool that legitimately takes a while (a bounded move awaiting measured
 *  completion) read as a stalled model and killed the turn mid-wait. No total
 *  cap either: the step cap, the tools' own deadlines and the abort signal
 *  bound a turn. */
export const STREAM_STALL = {
  firstChunkMs: 90_000,
  chunkMs: 90_000,
} as const;
