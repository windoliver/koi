# @koi/forge-verifier

Multi-stage verification pipeline for forge artifacts (L2). Issue #1347.

**Scope: pipeline mechanics, not stage logic.** This package owns the
sequencing, short-circuit-on-failure, per-stage timing, and result-cache
plumbing. It ships three minimal built-in stages (syntax / type / test)
that delegate the actual checking to a caller-supplied predicate so the
pipeline stays free of compiler/test-runner dependencies. Heavier
stages — sandbox execution, adversarial probes, auto-generated test
cases, behavioral validation — live in follow-up packages and plug in
via the same `VerifierStage` interface.

## Surface (exact `src/index.ts` exports)

- `runPipeline(stages, artifact, options?): Promise<Result<ForgeVerificationSummary>>`
  — sequential orchestrator. Awaits each `VerifierStage.run` in order,
  records the `ForgeStageDigest` (name, passed, durationMs), and short-
  circuits on the first `{ ok: false }` outcome. The returned summary is
  always well-formed: `passed` reflects every stage, `totalDurationMs` is
  monotonic, `stageResults` contains exactly the stages that ran. On
  failure the returned `KoiError` carries `code: "VALIDATION"` and
  `context.stage` identifying the failing stage.
- `VerifierStage<I>` — the extension point. Two fields: `name: string`
  and `run: (artifact: I, ctx: StageContext) => Promise<StageOutcome>`.
  Adding a new stage means writing a new `VerifierStage` value and
  passing it into the `stages` array — no edits to `runPipeline`.
- `StageContext` — read-only context passed to each stage. Exposes
  `previous: readonly ForgeStageDigest[]` (digests of stages that have
  already run in this pipeline) and `signal?: AbortSignal` (propagated
  from `VerifyOptions.signal`). The `previous` array and each digest in
  it are runtime-frozen via `Object.freeze`, so a stage that casts away
  the `readonly` modifier still cannot rewrite the verification trail —
  attempted mutations throw in strict mode and are no-ops elsewhere.
- `StageOutcome` — discriminated on `ok`. Success carries no payload
  (digests are owned by the orchestrator). Failure carries `reason:
  string` and optional `cause: unknown`. The orchestrator converts
  failure into a `KoiError` and stops the pipeline.
- `createSyntaxStage(check): VerifierStage<I>`,
  `createTypeStage(check): VerifierStage<I>`,
  `createTestStage(check): VerifierStage<I>` — built-in stage factories.
  Each accepts a caller-supplied `check: (artifact: I) =>
  StageOutcome | Promise<StageOutcome>` and wraps it with the canonical
  stage name (`"syntax"`, `"type"`, `"test"`). Sync and async checks are
  both supported (the orchestrator awaits unconditionally).
- `VerifyOptions<I>` — `cacheKey?: (artifact: I) => string` (a function,
  not a static string, so the cache key MUST be derived from the
  artifact under verification — prevents one artifact's pass result
  from being served to a different artifact under the same external
  label); `cache?: VerificationCache`; `signal?: AbortSignal`.
- `CacheKeyFn<I>` — exported alias for `(artifact: I) => string`.
- `VerificationCache` — two methods: `get(key): ForgeVerificationSummary
  | undefined | Promise<...>`, `set(key, summary): void | Promise<void>`.
  Both `T | Promise<T>` so an in-memory `Map` and a remote KV present
  the same surface. **Only successful (`passed: true`) summaries are
  cached** — failures are intentionally re-run, since a failure may be
  due to a transient resource issue and a future caller might supply
  different inputs that succeed.
- `createMemoryCache(): VerificationCache` — trivial in-process backing
  for tests and single-process workflows. Unbounded — production callers
  should plug in an LRU or external store.

## Pipeline Semantics

| Property | Behavior |
|----------|----------|
| Order | `stages` are run in array order, sequentially. No parallelism. |
| Short-circuit | First `{ ok: false }` stops the pipeline. Remaining stages do not run and do not appear in `stageResults`. |
| Timing | Each stage's `durationMs` is measured with `performance.now()`. `totalDurationMs` is the sum of measured stage spans, not wall-clock end-to-end (so cache hits report 0). |
| Cache key | The user-supplied `cacheKey` is composed with a JSON-encoded fingerprint of the stage list (`[[name, version], ...]`) before any cache call. JSON-encoding (vs. naive string joins) ensures that names or versions containing reserved characters cannot collide. Adding, removing, renaming, or version-bumping a stage invalidates prior cache entries automatically. Bump `VerifierStage.version` whenever the stage's check semantics change in a way callers should re-verify. |
| Built-in factories | `createSyntaxStage` / `createTypeStage` / `createTestStage` accept an optional second `version` argument that flows into the fingerprint. Bump it on a compiler/runner upgrade to invalidate prior cached pass results. |
| Result immutability | Every returned `ForgeVerificationSummary` — both fresh and from a cache hit — is normalized through a deep-freeze so neither callers nor any cache backend implementation can hand back mutable state. The in-memory cache also deep-copies on `set`. A hostile or buggy backend cannot poison shared verification state. |
| Cache hit | When the composed key resolves, no stages run and the cached summary is returned verbatim. The pipeline does not re-validate cached summaries. |
| Cache miss | Pipeline runs normally. On `passed: true`, the summary is stored via `cache.set`. **Cache writes are best-effort**: a `cache.set` throw is caught, logged via `console.debug`, and the successful verification is still returned. Verifier availability does not depend on cache availability. |
| `sandbox` field | Always `false` — this package does not run a sandbox. Sandbox-bearing stages must be added by a downstream package and the orchestrator forwards their `sandbox` claim through (see "Sandbox flag" below). |
| Cancellation | `signal.aborted` is checked **before each stage starts AND after each stage completes (including the final stage)** before any success summary is returned. A stage that ignores the signal and returns a late `ok: true` cannot commit a pass that the caller has already given up on. The error is attributed to the stage that aborted. |

### Sandbox flag

`ForgeVerificationSummary.sandbox: boolean` is an L0 contract field
asserting that at least one stage executed the artifact in a sandbox.
Since the built-in stages don't sandbox, this package leaves the field
`false` by default. A downstream stage that does sandbox MAY set
`StageOutcome.sandboxed: true` (an optional success-side field) and the
orchestrator OR-folds those flags into the summary's `sandbox` value.

## Error Mapping

| Failure | `KoiError.code` | `context` |
|---------|-----------------|-----------|
| Stage returns `{ ok: false, reason }` | `VALIDATION` | `{ stage: <name>, reason }` |
| Stage `run` throws | `INTERNAL` | `{ stage: <name> }` (cause attached) |
| `signal.aborted` between stages | `TIMEOUT` | `{ stage: <next-name> }` |
| Cache `get` throws | propagated (not caught) | — |
| Cache `set` throws | swallowed; success returned | logged via `console.debug` |

`retryable` follows `RETRYABLE_DEFAULTS` — `VALIDATION` and `INTERNAL`
are not retryable, `TIMEOUT` is.

## Dependencies

- `@koi/core` (L0) — `Result`, `KoiError`, `RETRYABLE_DEFAULTS`,
  `ForgeVerificationSummary`, `ForgeStageDigest`.
- `@koi/forge-types` (L0u) — currently no exported symbol is consumed,
  but the dep is declared so this package can adopt `ForgePipeline` /
  `VerificationReport` shape promotions without a layer change.

No L2 peer imports. No external runtime dependencies.

## Non-Goals (deferred)

These were in the v1 verifier (`archive/v1/packages/forge/forge-verifier`,
~4K LOC) and are intentionally **not** in scope for this package:

- Sandbox execution (`verify-sandbox.ts`) — needs `@koi/code-executor`,
  tracked in #1379.
- Auto test-case generation (`generate-test-cases.ts`, ~16 KB) —
  separate concern, separate package.
- Adversarial verifiers (`adversarial-verifiers.ts`, ~17 KB) — pluggable
  stages once the contract is proven by the three built-ins.
- Brick workspace creation (`workspace-manager.ts`, ~11 KB) — belongs in
  forge-tools or its own helper.
- Trust-tier assignment (`verify-trust.ts`) — composes verifier output
  with policy; lives in `@koi/forge-policy`.
- Total-pipeline timeout enforcement — added once a real stage actually
  needs it; until then a wrapping `signal` is sufficient.

## Tests

`pipeline.test.ts` covers the six cases enumerated in the issue:

1. Valid artifact passes all stages → `ok: true`, `passed: true`,
   `stageResults.length === stages.length`.
2. Syntax error caught at first stage → fails with `stage: "syntax"`,
   later stages do not run.
3. Type error caught → fails with `stage: "type"`, syntax digest
   present, test stage does not run.
4. Test failure caught → fails with `stage: "test"`, syntax + type
   digests present.
5. Pipeline short-circuits on first failure → asserted via stage call
   counters.
6. Cache hit skips re-verification → asserted by stage call counters
   remaining at zero on the second `runPipeline` call.
