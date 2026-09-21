# Decider comparison — rules vs structured-output vs Jev (2026-09-21, offline)

Overnight desk work, no actuation: the arm was not moved, powered or observed. Everything here runs through `/api/decision/fixtures` and `/api/decision/smoke`, which never acquire a lease or touch `robo-io`. Eleven fixtures, identical observations and candidate sets for every strategy.

Live model: `typesafe-ai/jev` via Vercel AI Gateway. Gateway smoke passed at 973 ms (`reobserve` p=0.98). Nightly cap `ROBO_JEV_BUDGET_USD=2`; the whole exercise spent under $0.003 of a cumulative $0.0062.

## Results

| Strategy | Passed    | p50    | p95    | Cost          | Model calls   |
| -------- | --------- | ------ | ------ | ------------- | ------------- |
| rules    | **11/11** | 0 ms   | 0 ms   | $0            | none          |
| choice   | 10/11     | 308 ms | 388 ms | $0.000442     | every fixture |
| parallel | 8/11      | 302 ms | 374 ms | $0.000455     | every fixture |
| critic   | **11/11** | 0 ms   | 383 ms | **$0.000139** | 4 of 11       |

Three independent repetitions of `choice` and `parallel` produced **the identical pass count, the identical failing fixtures and the identical cost to six decimals**. These are systematic properties of the deciders, not sampling noise.

## What the model gets wrong

Every failure is a case where the correct action is _not to move_:

| Fixture | Correct | choice | parallel |
| --- | --- | --- | --- |
| `stale-observation` (age 1800 ms) | reobserve / wait | ok | **stop** |
| `motion-in-progress` (another owner's op running) | wait / reobserve | ok | **stop** |
| `failed-step-no-movement` (last step moved nothing) | reobserve / wait / stop | **shoulder_pan+1.8** | **shoulder_pan+1.8** |

Two distinct errors, and they point opposite ways:

- **`choice` and `parallel` both retry a step that just failed to move.** Offered the same candidate that produced no movement, the model picks it again. That is the decision that drove the 09-17 `repeated_failures` stalls, and it is the one that matters on hardware: a joint that did not move is usually against a limit or short of torque, and re-commanding it is how a run burns its budget without moving.
- **`parallel` reaches for `stop` on transient conditions.** A stale frame and another owner's in-flight operation are both things you wait out. Ending the session there throws away the run, which is exactly what cost nine minutes of search on 09-18 before protective stops were reclassified as pauses.

`rules` gets all eleven right because these cases are written down as rules.

## Why `critic` wins on both axes

`critic` is not "the model, reviewed". It is **rules first, model only for approval**. The `note` column shows the split: seven fixtures report `no review needed` and resolve in 0 ms with no model call, and only four ordinary motion decisions reach the model, which approves the rule's pick.

Every fixture the model gets wrong is in the no-review set. So `critic` is 11/11 not because the review catches the model's mistakes, but because **the model never gets a vote on the cases it fails**. That is also why it is the cheapest live strategy at roughly a third of `choice`: it buys model judgement only where judgement helps.

## Consequences

1. `critic` is the strategy to run on hardware. `parallel` should not drive an arm.
2. The comparison is now reproducible offline for free (`--mock`, 11/11 on all four) and for fractions of a cent live. It belongs in the loop before any hardware session, not after.
3. The gap worth closing is the retry: no decider except `rules` recognises "this step already failed to move" as disqualifying. The candidate set, not the prompt, is the place to fix it — a step that just produced no movement should not be offered again unchanged.
