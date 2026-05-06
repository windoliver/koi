# @koi/harness-search

Iterative refinement search over synthesized forge variants (L2).
Issue #1354.

**Scope: bounded refinement loop with Thompson-sampled continue/deploy.**
Given an initial variant (code + `ToolDescriptor`), repeatedly evaluate,
optionally refine on failures, and track the best variant — until one of
the typed `StopReason`s fires. Single-candidate synthesis itself lives in
`@koi/harness-synth` (#1353); this package owns exactly the outer
search/refinement loop, nothing more.

## Wiring

The package exports `linearSearch` and `parseRefinementOutput`. Inject
the refine + evaluate callbacks via config — no direct dependency on a
model adapter or `@koi/harness-synth` (peer L2-to-L2 imports are
forbidden).

`refine` returns the next candidate source as a plain string. **Wire-
format extraction is the caller's job**: `linearSearch` does not
impose a fenced-code, JSON-envelope, or any other contract on the
model response — that decision belongs to whoever wired the LLM. Use
`parseRefinementOutput` for fenced-code adapters, or unwrap a JSON
envelope yourself for `@koi/harness-synth`-style refiners. If the
wire format is unparseable, throw — the loop contains it as
`stopReason: "refine_failed"`.

```ts
const result = await linearSearch(initialCode, descriptor, {
  refine,                  // (code, failures, iter, max, signal) => Promise<string>
  evaluate,                // (code, descriptor, signal) => Promise<EvalResult>
  // REQUIRED whenever maxIterations > 1. Asserts both callbacks honor
  // their AbortSignal so a timed-out attempt's side effects cannot
  // overlap with the next iteration. Omit (or pass false) ONLY when
  // also passing maxIterations: 1 — otherwise linearSearch throws.
  adapterHonorsAbort: true,
  // ALSO REQUIRED whenever maxIterations > 1. The default redactor
  // strips every field for fail-closed safety, which leaves refine()
  // with no actionable evidence — the loop would degenerate into
  // unguided rewrites. Provide a sanitizer that allowlists the
  // diagnostic fields your evaluator emits, or `(f) => f` for
  // trusted in-process evaluators. Single-shot configs may omit it.
  sanitizeFailures: (failures) => failures,
  maxIterations: 20,
  convergenceThreshold: 1.0,
  minEvalSamples: 5,
  noImprovementLimit: 3,
  signal,                  // optional caller cancellation
  clock: Date.now,
  random: Math.random,
});
```

## Surface (`src/index.ts`)

- `linearSearch(initialCode, descriptor, config): Promise<SearchResult>`
  — main entry. Bounded — always terminates within `maxIterations`.
- `shouldContinue(continueState, deployState, random): boolean`
  — exposed for testing the Thompson-sampled explore/exploit decision.
- `parseRefinementOutput(raw): string | null`
  — optional helper for fenced-code adapters: extracts the canonical
  fenced code block from a model response. Returns `null` when the
  output is multi-block ambiguous, has a non-source language tag, or
  is empty. NOT called by `linearSearch` itself — callers pick a
  parser that matches their wire format.
- Types: `SearchNode`, `EvalResult`, `EvalFailure`, `RefineCallback`,
  `EvaluateCallback`, `SearchConfig`, `SearchResult`, `StopReason`,
  `TerminalDiagnostic`, `DEFAULT_SEARCH_CONFIG`.

## Semantics

- **Bounded.** Loop is hard-capped at `maxIterations` (default 20). It
  cannot run forever even with always-failing evaluators.
- **Greedy best-tracking.** Single best variant is kept across
  iterations; refinement always reads the latest emitted code. Tree
  branching is deferred — see "Out of scope".
- **Thompson sampling for continue/deploy.** A 2-arm bandit
  (`continue` vs `deploy`) decides whether to keep refining or stop.
  Sampling uses a mean+scaled-noise Beta approximation — sufficient for
  binary directional decisions; full Beta sampling for multi-arm
  selection lives in `@koi/variant-selection`.
- **Convergence has two gates.** A node is "converged" only when
  `successRate >= convergenceThreshold` **and** `sampleCount >=
  minEvalSamples`. Prevents declaring a fluky 1/1 success a winner.
- **Plateau detection.** Stops after `noImprovementLimit` consecutive
  iterations without strictly improving the best success rate.
- **No I/O of its own.** `refine` and `evaluate` are caller-injected —
  the package is deterministic given deterministic callbacks (useful
  for cassette-replay / golden tests).
- **Cancellation.** `config.signal` is forwarded to both callbacks.
  Aborting between iterations exits with `stopReason: "aborted"`.

## Stop reasons

| `stopReason`        | Meaning                                                |
|---------------------|--------------------------------------------------------|
| `converged`         | Best variant met threshold + min-samples gates.        |
| `budget_exhausted`  | Hit `maxIterations` without converging.                |
| `thompson_deploy`   | Sampler chose deploy over continue.                    |
| `no_improvement`    | `noImprovementLimit` consecutive flat iterations.      |
| `eval_failed`       | Evaluate callback threw or rejected.                   |
| `refine_failed`     | Refine callback threw or produced unusable output.     |
| `aborted`           | External `signal` aborted between iterations.          |

Every result carries the full `history` plus `converged: boolean` so
callers can publish on success or triage on failure without re-running.

`best` is `SearchNode | null`. It is `null` whenever no evaluation
completed — e.g. the run aborted, timed out, or threw on the first
iteration. Callers MUST handle null before treating the result as a
verified candidate; the package deliberately does NOT synthesize a
fallback node from the initial code, since that would be
indistinguishable from a real evaluated winner and could lead to
publishing unverified code after a transient failure.

Convergence requires `failures.length === 0` in addition to the rate
and sample gates. An evaluator returning a threshold-clearing
`successRate` together with a non-empty `failures` array is treated
as a contradictory payload and surfaces as `eval_failed`, not
`converged`.

Failure exits (`*_failed`, `*_timeout`, `aborted`) also populate
`terminalDiagnostic: TerminalDiagnostic | null` — a redacted record
with the failure `kind`, `iteration` index, and a static `causeClass`
label (`"TypeError"`, `"RangeError"`, …) when an exception was
captured. Successful exits leave it `null`. The package deliberately
does NOT surface error messages or stack traces — those belong to the
caller's evaluator/refiner, behind their own trust boundary.

## Out of scope

Single-candidate synthesis (`@koi/harness-synth`); failure
clustering / aggregation upstream of search; tree-branching strategies
(future work — current strategy is linear); persisted search trees
(future Grove integration); model adapter selection; verifier
configuration; publication of winning variants (forge-policy /
forge-integrity own that decision).
