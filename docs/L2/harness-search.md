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
forbidden). Typical L3 wiring builds `refine` from harness-synth's
`buildRefinementPrompt` + an LLM, and `evaluate` from a verifier + eval
harness.

```ts
const result = await linearSearch(initialCode, descriptor, {
  refine,                  // (code, failures, iter, max, signal) => Promise<string>
  evaluate,                // (code, descriptor, signal) => Promise<EvalResult>
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
  — extracts the first fenced code block from refinement output;
  caller keeps the prior code on `null`.
- Types: `SearchNode`, `EvalResult`, `EvalFailure`, `RefineCallback`,
  `EvaluateCallback`, `SearchConfig`, `SearchResult`, `StopReason`,
  `DEFAULT_SEARCH_CONFIG`.

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

## Out of scope

Single-candidate synthesis (`@koi/harness-synth`); failure
clustering / aggregation upstream of search; tree-branching strategies
(future work — current strategy is linear); persisted search trees
(future Grove integration); model adapter selection; verifier
configuration; publication of winning variants (forge-policy /
forge-integrity own that decision).
