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
  circuits on the first `{ ok: false }` outcome. **Rejects an empty
  `stages` array** with `INVALID_CONFIG` so a misconfigured caller cannot
  silently turn "no verifier configured" into a passing artifact.
  The returned summary is always well-formed: `passed` reflects every
  stage, `totalDurationMs` is monotonic, `stageResults` contains exactly
  the stages that ran. On failure the returned `KoiError` carries
  `code: "VALIDATION"` (or `"INTERNAL"` / `"TIMEOUT"` / `"INVALID_CONFIG"`)
  and `context.stage` identifying the failing stage.
- `VerifierStage<I>` — the extension point. Fields:
  - `name: string`
  - `version?: string` — bump to invalidate prior cache entries.
  - `sandboxed?: boolean` — declares (statically) whether this stage
    runs the artifact inside an isolation boundary. The orchestrator
    uses this declaration — not any cached value — to compute the
    summary's `sandbox` bit on cache hits, so a divergent cached
    `sandbox` value cannot bypass the current stage list. (See "Cache
    Trust Model" below — the cache is a trusted storage optimization,
    not a security boundary.)
  - `run: (artifact: I, ctx: StageContext) => Promise<StageOutcome>`.

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
- `createSyntaxStage(check, version?): VerifierStage<I>`,
  `createTypeStage(check, version?): VerifierStage<I>`,
  `createTestStage(check, version?): VerifierStage<I>` — built-in stage
  factories. Each accepts a caller-supplied
  `check: (artifact: I, ctx: StageContext) => StageOutcome | Promise<StageOutcome>`
  and wraps it with the canonical stage name (`"syntax"`, `"type"`,
  `"test"`). The `ctx` argument carries `signal` so checks can
  cooperatively cancel long-running work. Sync and async checks are
  both supported.
- `VerifyOptions` —
  - `namespace?: string` — REQUIRED non-empty string when `cache` is
    provided; partitions the cache by tenant/environment/suite so two
    callers sharing a backend cannot replay each other's attestations.
    Use any opaque constant per partition. Passing `cache` without
    `namespace` returns `INVALID_CONFIG`.
  - `cache?: VerificationCache` — storage backend. The library derives
    the artifact-side digest INTERNALLY from the validated frozen
    snapshot — no caller callback runs on the verifier stack.
  - `cacheReadFailure?: "fail" | "miss"` — behavior when `cache.get`
    throws. Defaults to `"fail"` (returns INTERNAL inside the Result
    envelope) — safe for pluggable stages that may have side effects.
    Opt into `"miss"` only when stages are KNOWN side-effect-free.
  - `signal?: AbortSignal` — forwarded to every stage. Signal-bearing
    callers participate in single-flight only as FOLLOWERS (their abort
    short-circuits their own wait without affecting the leader or other
    waiters); signal-free callers may BECOME the leader.
- **Cache-hit validation**: every cache hit is bound to its composed key
  AND checked against the current stage list (length, name and
  `passed: true` per index), the declared `sandbox` flag, and finite
  non-negative durations. A backend returning the wrong key, wrong
  stage names, mismatched sandbox, or NaN/Infinity durations is rejected
  and the pipeline re-verifies. This is **structural** defense — it
  catches corrupt or stale rows but **does not authenticate the
  payload**. See "Cache Trust Model" below.

### Cache Trust Model

The cache is a TRUSTED storage optimization, NOT a security boundary.
The verifier validates structural shape on read so a buggy or stale
backend cannot pass through obvious garbage, but it does NOT cryptographically
authenticate cached entries. A hostile backend that mints a
structurally-correct `CachedVerification` envelope CAN cause the
verifier to report `passed: true` for an artifact that was never run.
Callers MUST use a backend whose write path is restricted to trusted
producers (process-local memory, a tenant-isolated KV with
authenticated writes, etc.). For untrusted-storage scenarios, layer a
signed/HMAC'd envelope above this interface — the library does not
provide that out of the box.
- `VerificationCache` — wraps stored values in a `CachedVerification`
  envelope `{ key, summary }` so the verifier can detect a backend that
  returns the wrong key. Two methods: `get(key): CachedVerification
  | undefined | Promise<...>`, `set(key, value): void | Promise<void>`.
  Both `T | Promise<T>` so an in-memory `Map` and a remote KV present
  the same surface. **Only successful (`passed: true`) summaries are
  cached** — failures are intentionally re-run, since a failure may be
  due to a transient resource issue and a future caller might supply
  different inputs that succeed.
- `CachedVerification` — exported envelope type binding a summary to
  its composed key.
- `createMemoryCache(): VerificationCache` — trivial in-process backing
  for tests and single-process workflows. Unbounded — production callers
  should plug in an LRU or external store.

## Pipeline Semantics

| Property | Behavior |
|----------|----------|
| Order | `stages` are run in array order, sequentially. No parallelism. |
| Short-circuit | First `{ ok: false }` stops the pipeline. Remaining stages do not run and do not appear in `stageResults`. |
| Timing | Each stage's `durationMs` is measured with `performance.now()`. `totalDurationMs` is the sum of measured stage spans, not wall-clock end-to-end (so cache hits report 0). |
| Cache key | Composed from `[namespace, artifactFingerprint, stagesFingerprint]` via `JSON.stringify`. The stage fingerprint is `[[name, version, sandboxed], ...]` — `sandboxed` is included so that flipping a stage from non-sandboxed to sandboxed (without bumping `version`) cannot reuse old non-sandbox cache entries and have them returned as `sandbox: true`. Adding, removing, renaming, version-bumping, or sandbox-flipping a stage invalidates prior cache entries automatically. |
| Built-in factories | `createSyntaxStage` / `createTypeStage` / `createTestStage` accept an optional second `version` argument that flows into the fingerprint. Bump it on a compiler/runner upgrade to invalidate prior cached pass results. |
| Result immutability | Every returned `ForgeVerificationSummary` — both fresh and from a cache hit — is normalized through a deep-freeze so neither callers nor any cache backend implementation can hand back mutable state. The in-memory cache also deep-copies on `set`. A hostile or buggy backend cannot poison shared verification state. |
| Cache hit | When the composed key resolves, no stages run and the cached summary is returned verbatim. The pipeline does not re-validate cached summaries. |
| Cache miss | Pipeline runs normally. On `passed: true`, the summary is stored via `cache.set`. **Cache writes are best-effort**: a `cache.set` throw is caught, logged via `console.debug`, and the successful verification is still returned. Verifier availability does not depend on cache availability. |
| `sandbox` field | Always `false` — this package does not run a sandbox. Sandbox-bearing stages must be added by a downstream package and the orchestrator forwards their `sandbox` claim through (see "Sandbox flag" below). |
| Cancellation | `signal.aborted` is checked at every observable point: before the cache lookup, after the awaited `cache.get`, before each stage starts, AND after each stage completes (including the final stage) before any success summary is returned. A late stage success or a slow cache read cannot commit a pass that the caller has already given up on. |
| Cyclic artifacts | Self-referential plain objects and arrays are accepted (a `WeakSet`-based visited tracker prevents stack overflow during shape validation). `structuredClone` handles the actual snapshot. |

### Sandbox flag

`ForgeVerificationSummary.sandbox: boolean` asserts at least one stage
executed the artifact in an isolation boundary. **One canonical
source**: `stages.some(s => s.sandboxed === true)`. The same
expression computes the value on fresh runs and cache hits, so the
trust signal cannot diverge across cache state. Stages that report
`StageOutcome.sandboxed` at runtime must agree with their static
`VerifierStage.sandboxed` declaration; mismatch returns
`INVALID_CONFIG` rather than committing an incoherent summary.

### Artifact snapshotting

`runPipeline` calls `structuredClone(artifact)` and then deep-freezes
the result (recursively, including arrays, Maps, and Sets) before
computing the cache fingerprint AND before running any stage. The
deep-frozen snapshot — not the caller's object — is what gets
fingerprinted, what every stage receives, and what the cached pass
attests to. An early stage that tries to rewrite nested fields throws
in strict mode (which all our code is in), so a later stage cannot
verify content different from what was fingerprinted.

**Supported artifact shape**: primitives (string, number, boolean,
undefined), arrays, and plain objects (`Object.prototype` or null
prototype) that contain only data properties. Explicitly **rejected**
with `INVALID_CONFIG` (anywhere in the artifact graph, including the
root):

- `Map` / `Set` — `Object.freeze` does not block `.set` / `.add` /
  `.delete`, so the immutability claim cannot be honored.
- Typed arrays / `ArrayBuffer` / `DataView` — `Object.freeze` throws
  on populated typed arrays, and a frozen view's underlying buffer
  remains mutable.
- Class instances (non-plain prototypes) — `structuredClone` strips
  the prototype, so stages would receive a plain-object that is not
  the shape the caller passed in and the cached pass would attest
  to a different value.
- Functions and symbols — non-cloneable, and at the root would also
  bypass freezing entirely.
- Accessor properties (getters/setters) — invoking a getter during
  validation would execute caller-supplied code on the verifier's
  call stack BEFORE any sandboxed stage. Validation walks
  `Object.getOwnPropertyDescriptors` (not `Object.entries`) so
  getters are never invoked.
- Symbol-keyed own properties — `structuredClone` drops them, so
  they would never appear in the snapshot, the cache key, or what
  stages see.
- Non-enumerable own properties — same reason as symbol keys; would
  silently disappear from the verified snapshot.

This keeps the cache pass guarantee tight: every cached attestation
is bound to the exact frozen snapshot that every stage saw.

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
