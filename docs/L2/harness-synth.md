# @koi/harness-synth

LLM-driven synthesis of forge candidates into verified artifacts (L2).
Issue #1353.

**Scope: single-candidate synthesis with verifier-driven retry.** Given a
`ForgeCandidate` and a target tool descriptor, runs

```
prompt → generate (LLM) → parse → verify → on-fail: refine → retry
```

up to a configured `maxAttempts`. Returns either a verified artifact or a
typed failure reason. Multi-candidate fitness search and Thompson-sampling
refinement live in `@koi/harness-search` (Issue #1354) — this package owns
exactly the loop above, nothing more.

## Wiring

The package exports `synthesize` and prompt/parser primitives. Inject the
LLM and verifier callbacks via config — no direct dependency on a model
adapter or `@koi/forge-verifier` (L2-to-L2 imports are forbidden).

```ts
const result = await synthesize(input, {
  generate,             // (prompt, signal) => Promise<string>
  verify,               // (code, descriptor, signal) => Promise<VerifyResult>
  maxAttempts: 3,
  attemptTimeoutMs: 30_000,
  // Required: assert that BOTH callbacks honor the signal arg. When false,
  // the loop forces single-shot (no retries) but still honors timeouts and
  // the external signal — synthesize() resolves promptly even if the
  // callback keeps running. The caller accepts that background work may
  // continue past the API boundary as the cost of a non-abort-aware adapter.
  adapterHonorsAbort: true,
  signal,               // optional caller cancellation
  clock: Date.now,
  // Default sanitizer drops verifier reason (forwards a fixed generic string
  // to the model on retry). Verifier output crosses a trust boundary back
  // into the LLM provider — opt in explicitly to forward diagnostics.
  // sanitizeVerifierReason: (s) => s,        // pass-through (trusted verifier)
  // sanitizeVerifierReason: stripSecrets,    // caller's own redactor
});
```

`input.targetToolSchema` is required: the synthesized
`descriptor.inputSchema` must structurally equal it. Schema compatibility
is a hard invariant, not a hint — synthesis cannot succeed with a different
input contract than the caller's intended tool.

## Surface (`src/index.ts`)

- `synthesize(input, config): Promise<SynthesisResult>` — main entry. Runs
  prompt → generate → parse → verify, retrying with a refinement prompt on
  parse or verify failure until `maxAttempts` is exhausted.
- `buildSynthesisPrompt(ctx)` — initial prompt builder (pure).
- `buildRefinementPrompt(ctx)` — retry prompt builder; carries the prior
  attempt + failure reason.
- `parseSynthesisOutput(raw, targetToolName)` — extracts `code` +
  `ToolDescriptor` from LLM output.
- Types: `SynthesisInput`, `SynthesisOutput`, `SynthesisConfig`,
  `SynthesisResult`, `GenerateCallback`, `VerifyCallback`, `VerifyResult`,
  `DEFAULT_SYNTHESIS_CONFIG`.

## Semantics

- **Single-candidate.** One call = one candidate. Caller controls
  multi-candidate strategy.
- **Bounded retry.** Loop terminates after `maxAttempts` (default 3) or on
  the first verified parse, whichever first.
- **Refinement carries context.** On retry, the next prompt includes the
  prior code + failure reason; callers do not write retry logic.
- **Result is a discriminated union.** Success carries `SynthesisOutput`
  (code, descriptor, `attempts`, verification summary). Failure carries
  `reason: string` and `attempts`.
- **No I/O of its own.** Generate + verify are injected. The package is
  deterministic given a deterministic `generate` callback — useful for
  cassette-replay tests.
- **`forgedBy` provenance.** Every output is tagged with the package name
  to prevent recursion in upstream demand aggregators.

## Out of scope

Multi-candidate fitness search (`@koi/harness-search`); failure
aggregation/clustering (upstream of synthesis); model adapter selection;
verifier stage configuration; forge policy / scope decisions; persisted
artifact storage.
