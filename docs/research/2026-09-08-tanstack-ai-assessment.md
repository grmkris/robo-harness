# Should Robo Harness replace Vercel AI SDK with TanStack AI?

**Recommendation: retain Vercel AI SDK for the current production harness.** TanStack AI is a credible alternative with useful application-level composition, but the evidence does not justify a replacement for our present workload. Revisit it for a specific expansion—such as a richer agent workbench with shared tool UI, durable chat, and coding-agent integrations—and require a bounded compatibility pilot before adopting it.

Prepared **2026-09-08** for Robo Harness's maintainer/operator. Repository baseline: `b02e0c3`. This assessment covers the actual Bun coordinator, React workbench, Alibaba/Grok model paths, Effect schemas, and supervised robot actions. It includes official documentation, published package source, an upstream checkout, and offline executable probes. No provider inference, hardware commands, dependency migration, or deployment was performed.

## What was compared

| Component | Version examined | Relevance |
| --- | --- | --- |
| Existing Vercel core | `ai@7.0.79` | Installed in the harness; primary compatibility baseline |
| Latest Vercel core | `7.0.93`, published September 4 | A patch review is a separate, smaller change |
| Existing compatible adapter | `@ai-sdk/openai-compatible@3.0.37` | Both Alibaba and xAI use this |
| TanStack core | `@tanstack/ai@0.53.0`, published September 3 | Published package used in execution probes |
| TanStack provider packages | `ai-openai@0.22.5`, `ai-grok@0.18.4` | Published September 3; source examined |
| Runtime/schema | Bun `1.4.2`, Effect `4.0.0-rc.112` | Existing runtime and schema bridge |

Versions and publication dates were checked against the [Vercel registry](https://registry.npmjs.org/ai), [TanStack core registry](https://registry.npmjs.org/@tanstack/ai), [OpenAI-adapter registry](https://registry.npmjs.org/@tanstack/ai-openai), and [Grok-adapter registry](https://registry.npmjs.org/@tanstack/ai-grok). Upstream source was pinned to [TanStack commit c17bc951](https://github.com/TanStack/ai/tree/c17bc951ca783d8023bf54d69035c19c0c72ea2f). The consequential provider/schema/tool-execution files examined matched the published packages; that does not establish that every feature on the latest website is published.

The supplied [agentic-cycle page](https://tanstack.com/ai/latest/docs/chat/agentic-cycle) is useful, but its central loop is already present in our application. The [migration guide](https://tanstack.com/ai/latest/docs/migration/migration-from-vercel-ai) explicitly targets Vercel versions 5 and 6, whereas the [comparison](https://tanstack.com/ai/latest/docs/comparison/vercel-ai-sdk) discusses version 7 while retaining some older claims. Treat both as orientation, then verify against installed APIs.

For example, AI SDK 7 already has stable telemetry and speech/transcription, richer lifecycle callbacks, tool approval policies, and explicit timeouts. These are understated in parts of the comparison. Its agent loop also permits custom stop predicates; TanStack's continue predicates do not create a new class of loop control. Both libraries allow deployment outside their vendors' platforms. [Vercel's version 7 announcement](https://vercel.com/changelog/ai-sdk-7), [Vercel loop control](https://ai-sdk.dev/docs/agents/loop-control).

## The comparison that matters here

| Requirement | Current harness / Vercel | TanStack contribution | Adoption value here |
| --- | --- | --- | --- |
| Multi-step tool use | `streamText`, per-step configuration, explicit 24-step budget and reserved summary | `chat`, loop strategies, lifecycle middleware | Similar capability; a rewrite would need to preserve our additional policies |
| Tool definitions | Effect validation plus advertised JSON Schema; server tools | Shared definitions with separate server/client implementations and input/output contracts | Useful if we build substantial client tool UI; limited benefit for server-only robot actions |
| Model capabilities | Runtime endpoint/model catalog and allowlist | Strong static narrowing for declared models | Limited with environment-driven custom model IDs; runtime checks remain necessary |
| Observability | Correlated call/run/action events; SDK lifecycle facilities | Composable middleware and devtools | A meaningful ergonomic advantage; existing SDK can also improve diagnostics |
| Streaming and history | Custom SQLite events, conversation history and React rendering | AG-UI events, headless chat client, persistence and resumable-stream adapters | Largest potential benefit if we adopt the whole chat/application layer |
| Motion correctness | Effect executor plus Python lease, lock, bounds and measured completion | General tool/abort/middleware primitives | Our safety implementation still owns this |
| Provider compatibility | Deployed Alibaba Token Plan and xAI paths | Compatible endpoints and dedicated provider adapters | Representable, but account/wire behavior needs fresh acceptance |
| Coding/analysis agents | Restricted Docker shell and standalone terminal | Code Mode, isolate drivers, coding-agent/sandbox integrations | Attractive for a separate development-agent feature |
| Model quality, latency and cost | Existing measured workflow | No demonstrated improvement from this assessment | No migration justification without workload measurements |

TanStack's middleware is its clearest backend design advantage: named, ordered components can adjust configuration, inspect chunks, intercept tools, and observe completion. Our scattered loop policies could be composed more cleanly this way. That is an architectural preference with potential maintenance value; it does not remove the policies themselves. [TanStack middleware](https://tanstack.com/ai/latest/docs/advanced/middleware).

Its UI layer also offers real value. The same headless client underlies framework bindings; AG-UI gives an external interoperability target, and persistence/reconnect have explicit adapter contracts. We currently do not use Vercel's React hooks or UI wire protocol, so a backend swap alone would not deliver these benefits. Adopting the client requires mapping our robot activity/progress events and conversation storage too. [TanStack client architecture](https://github.com/TanStack/ai/blob/c17bc951ca783d8023bf54d69035c19c0c72ea2f/packages/ai-client/src/chat-client.ts), [persistence guide](https://tanstack.com/ai/latest/docs/persistence/overview).

TanStack's resumable streams replay previously produced events; they do not automatically restart a dead model producer. The documentation also warns that reconnect can repeat the surrounding POST handler, so application side effects need a resume guard. Our action ledger must remain authoritative even if transcript or stream storage changes. [Resumable streams](https://tanstack.com/ai/latest/docs/resumable-streams/overview).

Code Mode is worth revisiting for bounded calculation and development work. TanStack documents multiple isolate drivers, including a Bun-specific QuickJS driver. Putting low-level robot lease calls into generated programs would still require the same action supervision and admission checks. [Isolate drivers](https://tanstack.com/ai/latest/docs/code-mode/code-mode-isolates).

## What the executable checks found

Tests used the **published TanStack core**, synthetic adapter events, and in-memory tools. They made no network requests to model providers or robot services. These are behavioral observations, not a complete integration certification.

| Probe | Observed result | Implication |
| --- | --- | --- |
| Two server tools returned in one model response | `first:start → first:end → second:start` | Server execution was sequential in the tested release |
| Same response under `maxIterations(1)` | Both tools executed; one model turn | A turn cap is not a side-effect cap |
| First tool aborts the controller, waits, then returns; second ignores its signal | Second tool began with `abortSignal.aborted === true` | Cancellation is cooperative; do not rely on the scheduler to suppress every subsequent side effect |
| Same cancellation, with `throwIfAborted()` before the second tool's work | Second side effect did not execute | Our existing explicit boundary guard is effective and must survive a port |
| Raw JSON Schema passed to the schema parser with a string where a number was expected | Malformed value passed through | Advertising a schema alone does not establish runtime validation |
| Effect Standard Schema bridge | Wrong primitive rejected; default excess fields stripped | Standard Schema is compatible, but default excess-field handling differs from our current boundary |
| Effect bridge configured to reject excess properties | Valid value accepted, wrong/excess input rejected | Preserve strict Effect decoding explicitly |

The cancellation scenario intentionally included a tool that ignored its signal. It demonstrates why application guards remain necessary; it is not evidence that a migrated tool retaining our executor would move the robot after Stop. The full `chat()` probe asserted both the unguarded and guarded outcomes. Relevant implementation: [published-equivalent tool executor](https://github.com/TanStack/ai/blob/c17bc951ca783d8023bf54d69035c19c0c72ea2f/packages/ai/src/activities/chat/tools/tool-calls.ts), [schema converter](https://github.com/TanStack/ai/blob/c17bc951ca783d8023bf54d69035c19c0c72ea2f/packages/ai/src/activities/chat/tools/schema-converter.ts).

Another migration trap: input parsing and Standard Schema validation happen before `onBeforeToolCall`. Its argument-transform hook therefore does not substitute directly for Vercel's invalid-call repair hook. Neither automatic coercion nor repair should be introduced for motion arguments as part of an SDK migration.

Sequential server tools could avoid the particular same-response acquisition race from the original failed conversation. They would not solve a three-second lease expiring while the model reasons between responses, nor ensure that a target was selected from a fresh observation. We have already addressed those problems through a supervised `move_joints` action, strict validation, and one side effect per response. See the [accepted motion design](../decisions/0004-supervised-chat-motion.md) and [live Qwen acceptance](../acceptance-2026-09-08-chat-actions.md).

## Alibaba, Grok and Effect: feasible, with specific traps

A TanStack pilot should use `openaiCompatible` from **`@tanstack/ai-openai/compatible`**. The factory supports a custom base URL, fetch implementation, model IDs and provider options. Those capabilities can express our Alibaba Token Plan endpoint and dynamic xAI credential-refresh path. This is source-level feasibility, not confirmation that our accounts will accept identical requests. [Compatible adapter](https://tanstack.com/ai/latest/docs/adapters/openai-compatible).

Four details matter:

1. **Keep runtime model admission.** Generic adapter model declarations mainly improve static typing; an environment-derived `string[]` cannot provide a finite compile-time catalog. Bare string models also assume image capability optimistically. Preserve our endpoint/model checks and explicit image-disable settings. [Factory and types](https://github.com/TanStack/ai/blob/c17bc951ca783d8023bf54d69035c19c0c72ea2f/packages/ai-openai/src/compatible/index.ts).
2. **Preserve the xAI protocol initially.** The dedicated `grokText` adapter uses Responses; our deployed route uses Chat Completions. Switching SDK and endpoint protocol together would obscure failures. Start with the generic compatible adapter, retaining token refresh. [Grok adapter source](https://github.com/TanStack/ai/blob/c17bc951ca783d8023bf54d69035c19c0c72ea2f/packages/ai-grok/src/adapters/text.ts).
3. **Set retries explicitly.** Our loop sets `maxRetries: 0`. TanStack's compatible client forwards configuration to the OpenAI client; inspected OpenAI 6.41.0 defaults to two retries and a ten-minute request timeout. Preserve zero retries and our separate provider/tool deadlines. This is a transport-policy difference, not proof that HTTP retries automatically duplicate a robot action. [OpenAI client source](https://github.com/openai/openai-node/blob/v6.41.0/src/client.ts).
4. **Retain strict schemas and camera insertion.** TanStack can encode JPEG image parts, but its message shape differs. Preserve post-tool image insertion before the next inference, MIME type, freshness metadata, and removal of image bytes from durable history. For tools, retain Effect validation with excess-property rejection; do not port only the generated JSON Schema. [Image conversion source](https://github.com/TanStack/ai/blob/c17bc951ca783d8023bf54d69035c19c0c72ea2f/packages/openai-base/src/adapters/chat-completions-text.ts).

TanStack's synchronous tool schema parser also does not support an Effect refinement that becomes asynchronous. Our current motion-input schemas do not need that feature, so this is a constraint to document rather than a present blocker.

## Migration cost in this codebase

A meaningful migration would touch more than the SDK import:

| Existing code | Work required |
| --- | --- |
| [`providers.ts`](../../apps/server/src/providers.ts) | Adapter construction, custom fetch, retry policy, provider options, image/model catalog |
| [`loop.ts`](../../apps/server/src/loop.ts), [`stop-conditions.ts`](../../apps/server/src/stop-conditions.ts) | Map steps to iterations, retain summary-only execution guards, dynamic tools, steering, failure/cycle limits and image injection |
| [`stall-watchdog.ts`](../../apps/server/src/stall-watchdog.ts) | Preserve provider-only silence detection; a legitimate tool wait must not count as a stalled model |
| [`chat-tools.ts`](../../apps/server/src/chat-tools.ts) | Port schema/execution wrappers; preserve action IDs, admission, capability checks, errors and cancellation |
| [`chat-runs.ts`](../../apps/server/src/chat-runs.ts) | Map stream events and persisted SDK message shapes, including historical conversations and image redaction |
| [`use-events.ts`](../../apps/web/src/hooks/use-events.ts), chat rendering | Optional for a backend-only port; required to gain TanStack's client/persistence benefits |
| Existing loop/action/provider tests | Keep domain tests and add adapter conformance fixtures for both wire formats |

The Python engine, action ledger, supervised motion executor, hardware profile, terminal container boundary and authenticated human Stop should remain independent of the SDK. Generic TanStack locks coordinate application work; they are not a replacement for motor ownership or measured completion.

**Assessment:** a backend-only replacement has moderate implementation cost and substantial regression-validation cost, while retaining most custom code. A full application-layer adoption could remove more UI/orchestration code, but is a broader product refactor. These are scope judgments, not elapsed-time estimates or benchmarks.

TanStack remains pre-1.0 and its core currently pins an AG-UI canary version. That is a versioning consideration, not proof of poor quality. Recent tuple-schema and reasoning-replay fixes show active maintenance and the need for pinned compatibility tests. The tuple fix is already merged and present in the inspected package; it is not an outstanding blocker. Vercel also has breaking majors and frequent corrections. [TanStack manifest](https://github.com/TanStack/ai/blob/c17bc951ca783d8023bf54d69035c19c0c72ea2f/packages/ai/package.json), [tuple fix](https://github.com/TanStack/ai/pull/1210), [reasoning replay fix](https://github.com/TanStack/ai/pull/1290), [Vercel 7 migration](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0).

## Concrete next steps

1. **Keep the production SDK and safety boundary.** The original tool/lease failures do not establish a need to change SDKs, and the revised Qwen path already has live acceptance evidence.
2. **Review the latest Vercel 7 patch separately.** Compare `7.0.79` to `7.0.93`, then run our existing fixtures before upgrading. Do not combine a patch upgrade with unrelated behavior changes.
3. **Improve our own reconnect handling.** Inspection found that `/api/events` reads `Last-Event-ID` but emits only `data:` fields, without SSE `id:` fields. The React hook deduplicates event rows, but its streaming draft appends deltas separately. Add cursor emission and draft deduplication with a reconnect test. This is a code finding, not a browser-reproduced defect in this assessment; it can be addressed independently of either SDK.
4. **Make an optional pilot answer a product question.** For example: can TanStack substantially simplify an agent workbench with persistent typed tool UI and coding-agent sessions? If yes, keep the existing robot executor behind a narrow SDK-neutral interface and port a read-only slice first. Do not maintain two production loops indefinitely merely to keep options open.
5. **Adopt only after concrete gates pass.** Require Alibaba/Grok request conformance; strict primitive/excess-property rejection; tuple/optional-field schema fidelity; camera insertion; zero retries; delayed-tool versus provider-stall separation; steering and summary enforcement; duplicate-action rejection; Stop/takeover during acquisition and execution; unknown-result/restart protection; and reconnect without re-running tools. Measure latency, token use and net code removed on the same scenarios. Promotion must be a separate reviewed implementation, not a consequence of this research.

The recommendation would change if TanStack demonstrates materially lower maintenance cost for features we actually intend to ship, while passing those gates. It should not change solely because its API reads more elegantly or its comparison table lists more features.

## Evidence limits

No live TanStack call was made to Alibaba or xAI. No migration branch, runtime dependency change, hardware action, performance benchmark, or complete UI port was made. Static model/provider support is not account-level conformance; the offline probes establish only their stated behaviors. Existing Vercel live acceptance is useful deployment evidence, not a comparative SDK benchmark.

Research stopped after the important loop, validation, provider, storage and migration claims had either primary support or explicit gaps. The remaining untested claims—live provider compatibility and net maintenance/performance benefit—require a scoped implementation experiment, not more feature-list searching.
