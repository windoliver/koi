# Edge Sandboxes Design (issue #1377)

**Date:** 2026-05-05
**Issue:** [#1377](https://github.com/windoliver/koi/issues/1377) — v2 Phase 3-sandbox-3
**Branch:** `feat/issue-1377-edge-sandboxes`

## Status: Design spec only

This branch contains this spec PLUS a 4-line PENDING-RECONCILIATION marker prepended to `docs/L3/sandbox-stack.md` (so `main` does not carry two competing authoritative contracts in the interim). It is not the implementation. Per CLAUDE.md "PR < 1500 lines logic", the implementation is split across multiple follow-up PRs (see "PR plan" below). Reviewing this branch reviews the design; reviewing the implementation requires the follow-up PRs.

## Goal

Port three v1 sandbox packages to v2:

- `@koi/sandbox-wasm` — in-process WebAssembly executor (SHIPS — PR 3)
- `@koi/sandbox-cloudflare` — Cloudflare Workers deploy + invoke adapter (SHIPS — PR 4)
- `@koi/sandbox-vercel` — Vercel Functions deploy + invoke adapter (**DEFERRED — design-only, NOT published, NOT runtime-integrated in this release**; see PR 5 acceptance for the promotion criteria)

All three are L2 packages depending only on `@koi/core` (and minimal L0u utilities) and implementing contracts defined in `packages/kernel/core/`. **The shipping bundle for this release is wasm + Cloudflare. The Vercel package is design-only:** its source lives in a `private` workspace excluded from the public-publish manifest, it is NOT wired into `@koi/runtime`, and its CI gates do NOT participate in the merge contract for v1. Vercel ships only after a separate promotion event documented in PR 5. Reviewers should treat any Vercel-touching change as deferred work, never as part of the v1 ship contract.

## Contracts

| Package | Contract |
|---------|----------|
| `sandbox-wasm` | **Package-local `WasmExecutor` contract** (NOT `SandboxExecutor`). |
| `sandbox-cloudflare` | **Package-local `EdgeFunctionAdapter` + `EdgeFunctionInstance` contracts** (NOT `SandboxAdapter`). |
| `sandbox-vercel` | Same as cloudflare. |

### Why wasm does not implement `SandboxExecutor`

The kernel `SandboxExecutor.execute(code: string, input: unknown, timeoutMs, ctx)` is a code-string contract — `code` is source text consumed by a runtime that can interpret it. Treating WASM bytes as `code: string` (e.g., base64) silently breaks generic consumers: a router that picks `SandboxExecutor` by capability cannot tell which executor will accept which payload, and routing a JS source string to a wasm-only backend produces a mis-execution that the contract cannot detect.

Therefore `sandbox-wasm` defines its own contract in `types.ts`:

```ts
export interface WasmExecutor {
  readonly execute: (
    moduleBytes: Uint8Array,
    call: { readonly export: string; readonly args: readonly unknown[] },
    options?: { readonly timeoutMs?: number; readonly maxMemoryPages?: number; readonly imports?: WebAssembly.Imports },
  ) => Promise<Result<WasmResult, SandboxError>>;
}
```

The input type is **`Uint8Array` only** — precompiled `WebAssembly.Module` inputs are deliberately not accepted. The host cannot recover original bytes from a `Module` to re-run the binary scanner, and `WebAssembly.Module.imports()` cannot detect an internal memory section. Accepting `Module` would silently bypass the host-memory invariant on one input path. If a caller has a precompiled module, they must round-trip through bytes; for repeated execution of the same module, the executor caches compiled `Module` instances internally keyed by SHA-256 of the validated bytes (cache lives within the package, never exposed).

This is intentionally NOT `SandboxExecutor`. Consumers wanting to plug wasm into a `SandboxExecutor`-shaped slot must build their own bridge that decides what `code: string` means for them (e.g., base64-of-bytes plus structured input). Building that bridge is out of scope for this PR — it would be a `sandbox-wasm-executor-bridge` follow-up package once a real consumer needs it.

### Why cloud adapters do not implement `SandboxAdapter`

`SandboxAdapter` is a process-level contract: `exec(command, args)` returns `{ exitCode, stdout, stderr, signal }` and existing call sites use it to run shell commands like `bash --noprofile --norc -c ...`. Cloudflare Workers and Vercel Edge runtimes execute **JavaScript**, not arbitrary shell commands; they have no `argv`/`exit code` model and no shell. A shim that pretends to honor `bash -c` would either embed a JS shell emulator (massive surface, wrong semantics) or silently fail at the first real call site.

Same reasoning as wasm: rather than overload `SandboxAdapter` and break router selection for downstream consumers, edge adapters define their own narrower contract:

```ts
// in @koi/sandbox-cloudflare/src/types.ts (also @koi/sandbox-vercel)
export interface EdgeInvokeRequest {
  readonly payload: unknown;          // arbitrary JSON-serializable input
  readonly operationId: string;       // REQUIRED — caller-owned, stable for the full logical operation, persists across destroy/recreate.
  readonly requestId: string;         // REQUIRED — UUIDv4 per network attempt. Used ONLY for shim-side per-isolate dedupe.
  /**
   * REQUIRED. Caller-supplied retry-horizon expiry as Unix ms. After this
   * timestamp, retries of the same operationId are REJECTED with
   * KoiError { code: "OPERATION_EXPIRED" } instead of silently re-executing.
   * The dedupe store retains the terminal record (and the expiry timestamp)
   * until at least dedupeExpiresAtMs + 1 hour, so retries that arrive between
   * the original commit and the expiry observe the cached result and retries
   * after the expiry observe OPERATION_EXPIRED.
   * Hard cap: 30 days from the moment of the first claim. Adapter rejects
   * larger values at construction with INVALID_DEDUPE_HORIZON.
   */
  readonly dedupeExpiresAtMs: number;
  /**
   * Caller WAITER budget. Time the host's invoke() will wait for a terminal
   * response (including any reclaim/takeover from a crashed prior owner).
   * Default 30_000 ms; max 30_000 ms. NOT capped by profile.resources.timeoutMs
   * because the WAITER and HANDLER budgets are distinct: handler-budget is
   * profile.resources.timeoutMs (max 10_000 ms — the reclaim-safe execution
   * limit); waiter-budget must EXCEED handler-budget plus lease+reclaim+RTT
   * slack so a takeover can complete inside one invoke window.
   */
  readonly waiterTimeoutMs?: number;
  readonly signal?: AbortSignal;
}
export interface EdgeInvokeResult {
  readonly output: unknown;           // JSON-deserialized response from the function
  readonly durationMs: number;
  readonly truncated?: boolean;
}
export interface EdgeFunctionInstance {
  readonly invoke: (req: EdgeInvokeRequest) => Promise<Result<EdgeInvokeResult, KoiError>>;
  readonly destroy: () => Promise<Result<DestroyOutcome, KoiError>>;  // see Cancellation honesty below
}
export interface EdgeFunctionAdapter {
  readonly name: string;
  readonly version: string;
  readonly create: (config: {
    readonly code: string;
    readonly profile: SandboxProfile;
    /**
     * REQUIRED. Workload classification — declares the side-effect contract
     * the handler obeys. v1 supports ONLY `"A"` (side-effect-free); other
     * values are rejected at construction with WORKLOAD_CLASS_NOT_SUPPORTED.
     * Carried on the package-local adapter config, NOT on `SandboxProfile`,
     * because workload classes are edge-adapter-specific and have no meaning
     * for OS-level / WASM / SSH adapters. The kernel `SandboxProfile` stays
     * unchanged.
     */
    readonly workloadClass: "A";
  }) => Promise<Result<EdgeFunctionInstance, KoiError>>;
}
```

Note the differences vs. `SandboxAdapter`:

- No `exec(command, args)` — replaced with `invoke(payload)` on a deployed JS function.
- No `readFile`/`writeFile`/`spawn` — these methods don't exist on `EdgeFunctionInstance`, so callers can't accidentally invoke them.
- `create` takes the JS source `code` to deploy, not just a profile.
- Returns `unknown` output, not stdout/stderr.

`SandboxProfile` is still consumed for resource caps and the policy enforcement table below. The router does NOT route `SandboxProfile`-keyed selection to these adapters, because they are not `SandboxAdapter`s. A consumer that wants edge function execution constructs the adapter directly and calls `invoke()`.

A future `sandbox-edge-router` package can offer cross-provider selection between Cloudflare and Vercel; that's out of scope here.

### Existing L3 doc reconciliation

`docs/L3/sandbox-stack.md` (lines ~308-337) currently documents `createCloudflareAdapter` and `createVercelAdapter` as returning `SandboxAdapter` via `createCloudSandbox()`. This is a forward-looking placeholder from a prior planning pass — the v2 packages do not exist yet on `main`. The L3 doc MUST be updated as part of **PR 2** (kernel + runtime extension), NOT PR 1 (this spec). PR 1 ships the design doc only and does not modify any existing repo contract docs; PR 2 reconciles `docs/L3/sandbox-stack.md` atomically with the introduction of `EdgeFunctionAdapter` types in `@koi/core`. The intermediate state on `main` after PR 1 merge is: this design doc explicitly notes that `docs/L3/sandbox-stack.md` is stale pending PR 2, and PR 2's CI gate refuses to merge unless the L3 doc reconciliation is included in the same PR. This is the single authoritative scoping rule; if PR 1 ever needs to ship the L3 reconciliation, the PR-1 row in the delivery table below is updated explicitly. Until PR 2 lands, `main` carries this design doc + the stale L3 doc with a marker pointing at this spec — not two competing authoritative contracts:

- The packages return `EdgeFunctionAdapter`, not `SandboxAdapter`.
- They are NOT consumed by `createCloudSandbox()` or by `@koi/sandbox-router`.
- The Cloudflare adapter is accessed through a `koi.edge.cloudflare` slot on the runtime (see Runtime Integration below). **The Vercel adapter does NOT get a runtime accessor in this release.** Operators who opt into the experimental Vercel package import it directly as `@koi/sandbox-vercel`. Adding `koi.edge.vercel` is gated on PR 5's promotion criteria (provider-owned cleanup primitive OR mechanically-verifiable isolation). This prevents reviewers and consumers from treating a runtime-exposed Vercel slot as supported before its required CI gates are actually in force.
- The L3 doc gets a new "Edge functions" subsection that documents the `invoke()`-only contract distinct from the process-level `SandboxAdapter` contract.

PR 1 ships exactly two doc artifacts: this design spec, AND a 4-line PENDING-RECONCILIATION marker prepended to `docs/L3/sandbox-stack.md`. The substantive L3 rewrite (removing `createCloudSandbox` cloudflare/vercel rows, adding the Edge functions section, etc.) is a required deliverable of **PR 2**, not PR 1. The earlier "required deliverable of this PR" language referred to PR 2's reconciliation requirement and is clarified here so PR-1 scope is unambiguous: marker-only on the L3 doc, full design content in this spec.

### Idempotency model: durable dedupe + class-A workload restriction (single contract for v1)

**v1 admits ONLY `workloadClass: "A"` (side-effect-free handlers).** This is the single authoritative idempotency story for the release: there is no operator-attestation path, no `assertIdempotent` flag, no class-B mediated-outbound path in v1. All those concepts are deferred to a future PR and explicitly NOT part of the v1 contract.

The adapter provides cross-retry dedupe via a strongly-consistent provider-side durable store (CF Durable Objects; Vercel KV — eventually-consistent stores like Cloudflare KV are insufficient because their 60-second propagation window allows cross-instance retries to miss just-written entries). The durable store mechanically enforces dedupe on the happy path and on the majority of failure paths — a retry that arrives after a successful commit observes the cached terminal record and never re-runs the handler.

**Several documented partial-failure paths still permit handler re-execution after the handler ran but before the terminal record persisted:**
- Cloudflare DO `complete` retry exhaustion (`DEDUPE_PERSISTENCE_FAILED` after 3 attempts) — handler ran, terminal record never persisted, lease expires, retry re-runs.
- Vercel KV lease loss mid-handler (`LEASE_LOST`) — handler ran, lease was reclaimed by another isolate before commit, this isolate cannot commit, the new owner re-runs.
- Vercel KV ownership loss at commit (`OWNERSHIP_LOST`) — same shape: handler ran, commit blocked because another isolate took ownership, re-runs.
- Oversized successful results were a fourth such path; that one is now closed by writing a permanent `RESULT_TOO_LARGE_PERMANENT` failed-permanent terminal record.

**Under the v1 class-A restriction these re-execution paths are intrinsically harmless** — a class-A handler is a pure function of `payload`, has no external side effects (no `fetch`, no DB writes, no queue publishes — enforced by the runtime fence + recursive AST scan + provider-mutable globals catalogue), and re-running it produces no observable duplicate effect beyond compute cost. The dedupe store's job in v1 is therefore to cache OUTPUTS for caller convenience, not to mechanically prevent duplicate side effects (because there are no side effects to prevent).

**The deferred class-B story (mediated outbound side effects with attestation + lint + downstream-idempotency keying)** is preserved in this spec for the future PR but does NOT participate in v1's contract. Any reference to "operator-attested downstream idempotency" elsewhere in this document refers to that future class-B work, not v1.

The L2 doc carries this contract verbatim in its first section so callers cannot mistake the mechanism for stronger.

#### Two-worker isolation: handler code never sees dedupe credentials

The deployed shim is a **two-worker** (or two-function) pattern, not one. Operator handler code never has access to dedupe state or credentials:

- **Worker A — `koi-dedupe-gateway`:** koi-owned. Holds the Durable Object binding (Cloudflare) or Vercel KV credentials. Source is the same `≤80 LOC` shim template the koi packages ship — operators do not modify it. Exposes only one method to Worker B: `runWithDedupe(operationId, payloadEnvelope)` which (a) checks the durable dedupe store, (b) if fresh, invokes Worker B via Service Binding (CF) or internal `fetch` (Vercel), (c) commits the result atomically. Worker A never executes operator code.
- **Worker B — `koi-handler-runner`:** runs the operator's handler. Has NO dedupe binding, NO dedupe credentials, NO direct access to KV/DO. It receives `payload`, `operationId`, and `requestId` as call arguments from Worker A and returns the handler result. The bearer token (`KOI_INSTANCE_TOKEN`) for shim-level auth is also held by Worker A only — Worker B does not need it because Worker A authenticates the inbound request before invoking it.
- **Communication:** Cloudflare uses Service Bindings (`env.HANDLER_RUNNER.fetch(req)`) — a private internal RPC channel that requires no auth and cannot be reached from outside the account. Vercel uses **per-pair Ed25519 asymmetric signatures** between Worker A and Worker B, NOT symmetric HMAC and NOT `x-vercel-signature`/Deployment Protection (both rejected for reasons documented below). The host generates a fresh Ed25519 keypair per A/B pair at create time: the **private signing key** (`KOI_PAIR_SIGNING_KEY`) is provisioned to Worker A only; the **public verification key** (`KOI_PAIR_VERIFY_KEY`) is provisioned to Worker B only. Every request from Worker A to Worker B carries `X-Koi-Pair-Sig` over a canonical string covering method, path, `operationId`, `requestId`, fresh nonce, timestamp, AND SHA-256 of the body — full canonicalization spec is in the trust-boundary section. Worker B enforces signature verification, body-hash match, timestamp freshness (≤60s old, ≤5s future), AND pair-scoped nonce uniqueness via Vercel-KV `SET NX EX 90`. Mismatch on any check → 401. Asymmetric is mandatory because Worker B runs operator code with read access to its own env: a symmetric secret in Worker B's env could be exfiltrated by a compromised handler and used to invoke Worker B directly bypassing Worker A. With Ed25519, the verify key in Worker B's env can verify but cannot sign — exfiltration does not enable forgery. The legacy `VERCEL_INTER_DEPLOYMENT_SECRET` term has been deprecated; references in this doc to "the per-pair Vercel secret" mean the Ed25519 signing-key/verify-key pair.
- **Guest cannot escalate:** since Worker B has no dedupe binding and no token, even a fully malicious handler cannot tamper with `claim:*`/`result:*` keys, forge dedupe records, or read KV credentials. The dedupe gateway is the trust boundary.
- **Operator surface:** the operator deploys ONLY Worker B's handler logic (their own code). Worker A is generated and deployed by the koi adapter from a fixed template; operators do not modify it. The L2 doc explicitly tells operators not to inspect or edit Worker A.

#### Cloudflare: Durable Objects with `compareAndSwap`

`createCloudflareAdapter` REQUIRES:
- `config.accountId: string`
- `config.apiToken: string`
- `config.ownerId: string` (non-empty; rejected as empty or `"default"`)
- `config.dedupeDurableObjectNamespaceId: string` (the DO namespace ID; the DO class definition itself is **koi-owned and shipped in this package**, not operator-authored)

Adapter construction fails with `KoiError { code: "DEDUPE_STORE_REQUIRED" | "OWNER_ID_REQUIRED" | ... }` if any field is missing or invalid.

**The DO class is koi-owned, not operator-authored.** The DO namespace points to a class defined inside `koi-dedupe-gateway` (Worker A), which the koi adapter deploys from a fixed source template colocated in this package. Operators do not write the `claim`/`complete`/`fail` methods — those are part of the koi shim source and are deployed atomically with Worker A. The operator's responsibility is reduced to:

1. Creating an empty DO namespace via Cloudflare dashboard or `wrangler` (one-time per fleet) and providing its ID.
2. Granting the API token DO migration permissions.

The adapter then binds the koi-shipped DO class to that namespace as part of the create flow. **Gateway integrity is verified on the INVOKE path with a fail-closed contract.** Per-mode tamper-window guarantees: **`strict`** (opt-in) collapses the window to ≈0; **`cached`** (DEFAULT) admits a bounded ≤1s window in exchange for amortized API rate; **`async`** (opt-in) admits a ≤30s window in exchange for full data-plane decoupling. Earlier prose that read "NO blind execution window" referred to strict mode specifically and is REWRITTEN here so the per-mode bounds are explicit at the section header. The earlier 60-second background-poll design (with no on-path verify) was rejected because it left a wider, undocumented gap; the three-mode architecture documents its bounds explicitly. The integrity mechanism:

  1. **Comprehensive deploy-time attestation pinning across BOTH workers in the pair.** At create time the adapter records the FULL set of mutable surface for Worker A AND Worker B — not just the gateway — as the **expected attestation bundle**. The `koi-attestation-fingerprint = sha256(canonicalJson({ A: workerAttestation, B: workerAttestation }))` where each `workerAttestation` is computed from:
     - `etag` from `PUT /workers/scripts/${name}` response (CF's content hash of the deployed bundle).
     - `sourceSha256` — locally-computed hash of the bytes the adapter just uploaded (independent witness).
     - `bindings` — sorted list of `{ name, type, target }` triples from `GET /workers/scripts/${name}/settings` (covers Service Bindings to Worker B, DO namespace bindings, KV bindings — drift in any of these is tamper).
     - `secrets` — sorted list of `{ name, created_on }` tuples from `GET /workers/scripts/${name}/secrets`. **The `created_on` timestamp is what makes secret VALUE mutation detectable even without API access to the value itself.** Cloudflare's secrets endpoint returns a per-secret `created_on` timestamp that updates on every `PUT /secrets` (including silent re-writes with the same name). Rotation changes `created_on` → fingerprint changes → tamper detected. This closes the prior gap where an attacker with API token could rotate `KOI_INSTANCE_TOKEN` to an attacker-chosen value silently. **Honest residual:** if CF ever changes the API to omit `created_on` or returns a stable timestamp across writes, the contract degrades — adapter MUST verify on adapter-init that `created_on` is present and unique-per-write via a self-test that runs ONLY against a **disposable probe Worker** named `koi-versioning-probe-${randomHex(8)}` (NEVER any live attested Worker A or Worker B). The self-test sequence is: (1) `PUT /workers/scripts/${probe-name}` with a no-op shim; (2) `PUT /workers/scripts/${probe-name}/secrets` for a probe secret named `KOI_VERSIONING_PROBE`; (3) read its `created_on` via the secrets-list endpoint; (4) re-`PUT` the same secret with a different value; (5) read `created_on` again; (6) assert the two timestamps differ; (7) `DELETE /workers/scripts/${probe-name}` regardless of outcome. The probe Worker is DISPOSABLE — its lifecycle is fully owned by adapter-init and it is never integrated into instance attestation. **No live Worker A/B is ever mutated by the self-test.** If the assertion in step 6 fails, adapter init rejects with `KoiError { code: "PROVIDER_SECRET_VERSIONING_UNAVAILABLE" }` and the operator must use a different deployment target — fail closed rather than ship an undetectable-tamper path. Adversarial test (mandatory): `__tests__/cf-secret-versioning-self-test-isolated.test.ts` asserts (a) the self-test only touches `koi-versioning-probe-*` workers, (b) on completion no `koi-versioning-probe-*` worker remains, (c) live Worker A/B fingerprints are unchanged across an adapter init.
     - `settings` — relevant deploy settings hash (`workers_dev`, `routes`, `compatibility_date`, `compatibility_flags`).
     **Both Worker A AND Worker B are first-class attested artifacts.** A mutation to Worker B's bytes, bindings, settings, or secret tuples drifts the combined fingerprint just like a mutation to Worker A. The earlier draft pinned only Worker A, which left an attacker free to mutate Worker B in place; the corrected design closes that gap. The `__koi_self_hash` data-plane endpoint is REMOVED from the integrity protocol — it is redundant with the control-plane `etag`/`sourceSha256` and the data-plane probe is suppressible by the artifact itself.

  2. **Integrity verification — single normative default and two opt-in modes.** `config.integrityVerification` defaults to `"cached"`. There is no other default model in this spec; earlier prose that read like an "async-default" alternative referred to the deferred opt-in `"async"` mode and is consolidated here as a single description per mode. **All three modes attest against the Cloudflare CONTROL plane** using the comprehensive attestation fingerprint from (1) — never against Worker A's data plane (which is suppressible by a tampered Worker A).

     **`"cached"` (DEFAULT — bounded 1-second cache + on-path verify on miss):**
     - At create() time the adapter pins `expectedAttestationFingerprint` for the instance's lifetime.
     - On every `invoke()`, the host checks if the cached `(attestationFingerprint, verifiedAtMs)` is younger than `cachedVerifyMaxAgeMs` (default `1_000` ms). If fresh → forward. If stale → block while a fresh control-plane verify (etag/settings/secrets for BOTH Worker A AND Worker B) completes with a 1-second timeout. On match, update cache and forward. On confirmed mismatch (any of etag, sourceSha256 over re-fetched bytes, bindings, secret-tuple list, or settings differs), permanently poison the instance with `DEDUPE_GATEWAY_TAMPERED` (sticky; only `destroy()` thereafter; process-local stop-flag halts in-flight invokes synchronously). On transient unavailable (timeout/5xx/network error), reject THIS invoke only with `DEDUPE_GATEWAY_INTEGRITY_VERIFY_UNAVAILABLE` (retryable) — the instance is not poisoned. If verify-unavailable persists past `staleVerifyBoundMs` (default 600s = 10 minutes), the instance transitions to recoverable poison `DEDUPE_GATEWAY_INTEGRITY_VERIFY_UNAVAILABLE_PERSISTENT` (permits `destroy()` AND `reattachAfterRestoredVerify()`).
     - **Rate-limit budget:** at most `1` control-plane read pair per second per instance, regardless of `Q`. Fleet-wide CF API QPS for integrity ≈ `2 × instanceCount`/s (independent of invoke rate).
     - **Tamper window:** ≤ 1 second.

     **`"strict"` (OPT-IN — per-invoke uncached verify):**
     - Same attestation fingerprint, no cache. Every invoke performs a fresh verify before forwarding.
     - Tamper window: ≈ 0. Hot-path latency includes the verify on every invoke. Hot path FAILS during any control-plane outage (no cache to absorb).
     - Suitable for low-QPS high-stakes deployments.

     **`"async"` (OPT-IN — background polling, no on-path verify):**
     - A background timer fires every 30 seconds and runs the same fingerprint check. Confirmed mismatch poisons. Transient unavailable does not poison; if it persists past `staleVerifyBoundMs` the instance transitions to recoverable persistent-poison.
     - Hot path is fully decoupled from the control plane: invoke checks only "not tamper-poisoned" + "most-recent-successful-verify within `staleVerifyBoundMs`". No per-invoke control-plane call.
     - Tamper window: ≤ 30 seconds (one polling interval) under the control-plane-honest threat model. `staleVerifyBoundMs` bounds availability under control-plane outage, NOT detection latency under tamper.
     - Suitable for high-QPS workloads where the operator monitors the CF API token externally.

     **Threat model (applies to all three modes).** The mechanism protects against an attacker who has stolen or coerced the CF API token and can mutate Worker A or Worker B (bytes/bindings/settings/secrets). The koi adapter's control-plane GETs cannot be suppressed by a tampered Worker, because they are served by Cloudflare's API. An attacker who compromises Cloudflare's control plane itself (suppresses or forges API responses) is OUT OF SCOPE. The L2 doc states all three trade-offs verbatim. Mode selection is operator policy; `"cached"` is the spec's recommended default.

  **Why this addresses the prior contradictions:** (a) the integrity check is now against an UN-suppressible signal (Cloudflare control plane, not Worker A's data plane), so a tampered Worker A cannot hide itself by suppressing the probe; (b) the attestation fingerprint covers script bytes, bindings, settings, AND secret names, so config-level mutations are detected on the same path as bytecode mutations; (c) the spec no longer claims zero exposure on the default path — it documents the bounded `30s` detection latency under the control-plane-honest threat model, and offers strict mode for callers who want a tighter bound at the cost of data-plane/control-plane coupling. The transient-vs-confirmed distinction means routine control-plane turbulence does not couple data-plane availability to control-plane health: Cloudflare API rate limits or 5xx blips degrade gracefully via per-request `INTEGRITY_VERIFY_UNAVAILABLE` (caller may retry, instance is not poisoned) instead of producing a fleet-wide outage requiring `destroy()` of every instance.

  **Adversarial tests (mandatory). `"cached"` is the default; tests are organized accordingly.** `__tests__/cf-gateway-tamper-detection-cached-default.test.ts` (DEFAULT MODE) (a) creates an instance with NO explicit `integrityVerification` setting (so `"cached"` is selected); (b) externally rewrites the gateway script source via Cloudflare API; (c) asserts that within `1s + cache-skew slack` (one full `cachedVerifyMaxAgeMs` window) `invoke()` begins rejecting with `DEDUPE_GATEWAY_TAMPERED` and the instance is permanently poisoned; (d) explicitly asserts the bounded-window contract — invokes issued before the cache expires forward (this is the documented 1-second residual of cached mode). `__tests__/cf-gateway-tamper-detection-strict-optin.test.ts` (opt-in strict mode) (a) creates an instance with `integrityVerification: "strict"`; (b) rewrites the gateway source; (c) asserts the very next `invoke()` rejects with `DEDUPE_GATEWAY_TAMPERED` BEFORE Worker A is contacted (zero-window). `__tests__/cf-gateway-tamper-detection-async-optin.test.ts` (opt-in async mode) (a) creates an instance with `integrityVerification: "async"`; (b) rewrites; (c) asserts detection within `30s + 1s slack` and persistent poison. `__tests__/cf-gateway-integrity-verify-transient-cached.test.ts` (DEFAULT mode) simulates a 30-second window of 503s and asserts (a) invokes whose cache is still fresh forward, (b) invokes that need a fresh verify reject this single request with `DEDUPE_GATEWAY_INTEGRITY_VERIFY_UNAVAILABLE` (per-request fail-closed), (c) the instance is NOT poisoned, (d) on recovery the next successful verify updates the cache and traffic resumes. `__tests__/cf-gateway-integrity-verify-persistent-cached.test.ts` (DEFAULT mode) simulates a 12-minute outage and asserts transition to `DEDUPE_GATEWAY_INTEGRITY_VERIFY_UNAVAILABLE_PERSISTENT` after `staleVerifyBoundMs` elapses, and that `reattachAfterRestoredVerify()` resumes traffic. `__tests__/cf-gateway-cache-budget.test.ts` (DEFAULT MODE budget verification) asserts the cached-mode amortized verify cost is at most `1` control-plane read pair per second per instance regardless of `Q`, and that on a cache-miss the per-invoke verify completes within `1s` 99th-percentile under load (so the host's 30s waiter cap accommodates `1s verify + 25s SHIM_POLL_DEADLINE_MS + 4s slack`).

DO is the only Cloudflare primitive with linearizable single-key consistency.

**Dedupe state machine** (operates on a single Durable Object instance per `operationId`):

```
fresh → claimed (claimer holds lease) → completed (terminal: result cached until dedupeExpiresAtMs + 1h)
                              \-------> failed-permanent (terminal: error cached until dedupeExpiresAtMs + 1h, retries see error)
                              \-------> claim-expired (lease ran out: any caller can transition to claimed)
```

Rules:

- `claim`: atomic compareAndSwap from `fresh|claim-expired` to `claimed`. The caller writes its `requestId`, `claimedAt`, `leaseUntil = claimedAt + 15_000ms`, AND `dedupeFingerprint` (a canonical `sha256("${ownerId}:${sha256(payload)}")` computed by Worker A's shim from the inbound request — note: BOTH `pairUUID` AND `handlerCodeHash` are INTENTIONALLY EXCLUDED. `pairUUID` would break retries across destroy/recreate. `handlerCodeHash` would break retries across routine handler rollouts: a caller that retries the same logical `operationId` after the operator deploys a hotfix would get `OPERATION_ID_CONFLICT` instead of observing the prior terminal record, which would push the caller toward generating a new `operationId` and re-triggering side effects. Handler-version drift is surfaced as **non-blocking telemetry** instead — see `handlerCodeHash` telemetry rule below) into the DO's transactional storage. Returns one of FIVE statuses to the caller:
  - `{ status: "fresh" }` — new owner, this isolate runs the handler.
  - `{ status: "in-progress", claimer: <other_requestId>, leaseUntil }` — loser; must poll via the wait protocol.
  - `{ status: "completed", result, statusCode }` — terminal cached success; return immediately to the caller without running the handler.
  - `{ status: "failed-permanent", error }` — terminal cached failure; return the cached error directly to the caller without running the handler. This is the **first-class wire response** for `failed-permanent`; loser/retry paths observe it via `claim` exactly the same way they observe `completed`.
  - `{ status: "fingerprint-conflict", storedFingerprint }` — the dedupe record exists for this `operationId` but its stored `dedupeFingerprint` differs from the incoming request's (i.e., the **payload bytes** differ). The host-side `EdgeFunctionInstance.invoke()` maps this to `KoiError { code: "OPERATION_ID_CONFLICT", message: "operationId reused with a different payload. operationId must be globally unique per logical operation." }`. The Lua/DO transaction performs the compareAndSwap on `(operationId, dedupeFingerprint)` together: a request with mismatched fingerprint NEVER overwrites the stored record AND NEVER claims a new run; the conflict is signalled and the caller's bug is surfaced loudly instead of silently aliasing two distinct logical operations onto one record. The same fingerprint check applies on `claim`, on terminal-cache hits (`completed`/`failed-permanent`), and on `complete`/`fail` writes.
  - **Retry-horizon enforcement is anchored on a durable per-operation ledger that OUTLIVES the result purge.** A naive design would check the request's `dedupeExpiresAtMs` against `now` on every claim, but once the terminal-result record is purged, a buggy or malicious caller could resend the same `operationId` with a forward-shifted `dedupeExpiresAtMs` and obtain fresh execution — the spec's "post-expiry retries fail loudly" guarantee would silently break the moment the alarm fires. To close this, the dedupe store maintains TWO records per `(ownerId, operationId)`:
    1. **Result record** — `{ status, result|error, completedAt|failedAt, ttlExpiresAt }`. Purged by the alarm at `ttlExpiresAt = dedupeExpiresAtMs + 3_600_000ms` (1h grace).
    2. **Operation ledger row** (immutable, write-once at first claim) — `{ firstClaimAtMs, originalDedupeExpiresAtMs, originalDedupeFingerprint, ledgerExpiresAtMs }`. Written atomically with the first successful `claim` transition. Carries its OWN longer retention: `ledgerExpiresAtMs = firstClaimAtMs + 30 days + 1 hour grace` (matches the documented hard cap on `dedupeExpiresAtMs`). The ledger row is the durable source of truth for the operation's expiry horizon and is never mutated after first claim.
  - **Every claim/wait path validates against the ledger, NOT the request:** on `claim`, if a ledger row exists, the shim ignores the request's `dedupeExpiresAtMs` and uses the stored `originalDedupeExpiresAtMs` instead. If `now > originalDedupeExpiresAtMs`, the shim returns 410 + `X-Koi-Result-Kind: operation-expired` regardless of whether the result record has been purged or what the request claims. The host adapter maps to `KoiError { code: "OPERATION_EXPIRED", originalDedupeExpiresAtMs }`. The request's `dedupeExpiresAtMs` is also compared against `originalDedupeExpiresAtMs` — if they differ by more than a small skew tolerance, the shim returns `OPERATION_ID_CONFLICT` with reason `EXPIRY_HORIZON_MISMATCH`. This makes forward-shifting the horizon on a retry loud, not silent.
  - **Ledger row retention dominates result retention.** The ledger row is purged by a separate alarm at `ledgerExpiresAtMs`. Until then, ANY retry against the same `(ownerId, operationId)` finds the ledger row and is bound by its `originalDedupeExpiresAtMs`, even if the result record was purged hours or days earlier. The 30-day cap from the contract is enforced at WRITE TIME on the ledger row's `originalDedupeExpiresAtMs` (rejected before claim if `dedupeExpiresAtMs > now + 30d`) AND at READ TIME on every retry. A retry arriving 31 days after first claim finds NO ledger row (already purged) AND NO result row — the operation is treated as fully forgotten and the caller's `operationId` is essentially fresh; this is the documented end-of-life for the operation. Callers who need longer retention must use a different `operationId` for a different logical operation.
  - **Post-expiry contract is a HARD cutoff (single authoritative rule, no carve-outs).** Once `now > originalDedupeExpiresAtMs`, every retry returns `operation-expired` — regardless of whether a cached terminal result still exists, regardless of the request's `dedupeExpiresAtMs`. The ledger check is performed FIRST in the claim/wait pipeline and short-circuits before any result-row lookup. Rationale: callers commonly use `dedupeExpiresAtMs` as a hard business cutoff (e.g., "retries are pointless after this deadline because the downstream order window has closed"); allowing a stale cached success to satisfy a post-deadline retry would silently violate that contract for up to the 1-hour result-grace window. The cached result remains in storage until its own alarm-driven purge (so on-time retries before expiry still benefit from the cache), but it is NOT served to retries past `originalDedupeExpiresAtMs`. The API doc comment, host-mapping table, and adversarial tests all reflect this single rule.
  - **Adversarial test (mandatory):** `__tests__/cf-do-post-expiry-hard-cutoff.test.ts` (a) writes a terminal `completed` result with stored value `"V1"` and a ledger row whose `originalDedupeExpiresAtMs` is 100ms in the future, (b) waits 200ms (past expiry, still inside the 1-hour result-grace), (c) issues a retry against the same `operationId`, (d) asserts the response is `operation-expired` — NOT `"V1"`. A second test, `__tests__/cf-do-ledger-survives-result-purge.test.ts`, additionally asserts that after the result purge alarm fires, the ledger still produces `operation-expired` (and that a forward-shifted `dedupeExpiresAtMs` produces `OPERATION_ID_CONFLICT/EXPIRY_HORIZON_MISMATCH` rather than fresh execution).
  - **Handler-version drift is telemetry only, never a conflict.** Each terminal record stores the `handlerCodeHash` of the isolate that produced it. On a `claim` or terminal-cache hit, if the incoming request's `handlerCodeHash` differs from the stored value, the shim emits a `KOI_HANDLER_VERSION_DRIFT` log event (operationId, storedHash, observedHash) and **still returns the cached terminal record to the caller without rejecting**. This preserves retry safety across routine rollouts while still giving operators a paper trail. The earlier draft included `handlerCodeHash` in `dedupeFingerprint`, which would have turned every legitimate cross-rollout retry into `OPERATION_ID_CONFLICT` and pressured callers into minting fresh `operationId`s — re-triggering side effects.
- **Heartbeat lease while running:** the running isolate calls `extendLease` every **5 seconds** — atomic CAS that sets `leaseUntil = now + 15_000ms` IFF the current claimer's `requestId` matches. If the heartbeat fails (isolate crashed, evicted), the lease expires within at most 15s and another isolate can take over via the `claim-expired` transition. **Reclaim-safe handler budget cap is `resources.timeoutMs <= 10_000ms`** — enforced at profile validation (see the validation table). The 30s waiter timeout decomposes as: ≤1s integrity verify (cached/strict) + 15s claim TTL + 1s poll + 1s claim transition + 10s handler + 1s commit + 1s slack = 30s. **Cached mode (default) and strict mode** budget up to 1s for the verify; cached mode amortizes it (verify only on cache miss, ≤1× per second per instance) so steady-state hot-path verify cost is near-zero. Async mode reclaims the 1s as additional slack on every invoke (verify is fully off the hot path). Reclaim-safe handler budget cap remains `resources.timeoutMs <= 10_000ms` enforced at profile validation. Handlers requiring longer than 10s end-to-end (including possible takeover overhead) MUST NOT be deployed and the validation table rejects them.
- **DO record purge mechanism (alarm-driven, two-phase):** Durable Object storage does NOT age out automatically — `ttlExpiresAt` and `ledgerExpiresAtMs` are logical timestamps, not provider TTLs. Purging is implemented explicitly with TWO alarm phases:
  - **Phase 1 (result purge):** every `complete`/`fail` transaction calls `state.storage.setAlarm(ttlExpiresAtMs)` (or extends an existing alarm to the latest `ttlExpiresAt` across the DO's records). When the alarm fires, the DO's `alarm()` handler iterates result records and DELETEs any whose `ttlExpiresAt < now`. The associated **ledger row is preserved** — it has its own retention.
  - **Phase 2 (ledger purge):** the same `alarm()` handler also iterates ledger rows and DELETEs any whose `ledgerExpiresAtMs < now`. Because `ledgerExpiresAtMs > ttlExpiresAt` always, ledger purge runs strictly after the corresponding result purge for any given operation. After ledger purge, the operation is fully forgotten — the next `claim` with the same `operationId` is treated as a brand-new operation (and may run fresh, subject to the new request's `dedupeExpiresAtMs`).
  - The alarm handler chooses its next fire time as `min(min(ttlExpiresAt across results), min(ledgerExpiresAtMs across ledger rows))` so neither retention curve is missed.
  - **Adversarial test (mandatory):** `__tests__/cf-do-record-purge.test.ts` writes a terminal record + ledger row with a near-future `ttlExpiresAt` (and a much later `ledgerExpiresAtMs`), waits past `ttlExpiresAt`, and asserts (a) the result record is deleted from DO storage, (b) the ledger row is still present, (c) a retry against the same `operationId` past `originalDedupeExpiresAtMs` returns `operation-expired` based on the still-present ledger.
- **Atomic completion (fail-closed on persistence failure):** `complete` is a single transaction that writes `{ status: "completed", result, statusCode, completedAt, ttlExpiresAt: dedupeExpiresAtMs + 3_600_000ms }` AND clears the claim AND schedules the purge alarm via `state.storage.setAlarm(ttlExpiresAt)`. If the handler succeeded but `complete` fails (network error, DO transient), the isolate retries `complete` up to 3 times with backoff. **After 3 failures, the isolate returns `503 DEDUPE_PERSISTENCE_FAILED` to the caller WITHOUT serving the handler's result.** The instance is poisoned. The host-side adapter, on receiving this response, transitions the local handle to POISONED and the caller's `invoke()` rejects with `KoiError { code: "DEDUPE_PERSISTENCE_FAILED" }`. The handler's external side effects already happened — but no result is returned to the caller, and the next retry of the same `operationId` will see the still-active claim, wait for it to expire, and then re-run. Because v1 admits only workloadClass: "A" (side-effect-free handlers), this re-run is intrinsically safe — there are no side effects to duplicate. **There is no path where the adapter reports success without persisting a terminal record.**
- **Atomic failure:** `fail` writes `{ status: "failed-permanent", error, failedAt, ttlExpiresAt: dedupeExpiresAtMs + 3_600_000ms }` for handler errors that the operator wants cached (e.g., validation failures with no retry semantics). The handler signals this **out-of-band** via the response header `X-Koi-Handler-Outcome: failed-permanent` (combined with an optional body of shape `{ "error": <serialized error> }`). Worker A reads the response header — NOT the body shape — to decide whether to commit `failed-permanent`. The koi handler-runtime helper provides `koi.failPermanent(error)` which returns a `Response` with the right header so handler authors do not hand-roll the wire shape. **A handler that returns a body resembling `{koi: {failed: true, ...}}` without the header is treated as a normal success body and the user payload is preserved verbatim.** Default behavior is to NOT cache failures — the next retry runs the handler fresh.
- **`failed-permanent` is a terminal state in BOTH protocols:** the `claim` endpoint returns it directly to retries that arrive after a permanent failure was cached, and the `waitForTerminal` polling protocol returns it to losers that were waiting when the owner committed a permanent failure. `waitForTerminal` polls the DO every 1 second (configurable) and exits as soon as it observes `completed` OR `failed-permanent` — these are the only TWO terminal states that end the wait. Polling timeout still produces a host-side `TIMEOUT` error; nothing about adding `failed-permanent` to the wire protocol changes the timeout behavior.
- **Out-of-band wire signaling — never overload the user payload namespace.** The shim's HTTP response uses **headers**, NOT body shape, to discriminate handler success from cached failure:
  - `X-Koi-Result-Kind: success` (HTTP 200) — the response body is the handler's `unknown` output, returned to the caller verbatim.
  - `X-Koi-Result-Kind: failed-permanent` (HTTP 200) — the response body is `{ "error": <serialized cached error> }`, in a koi-owned schema, NOT inside a `koi.*` envelope mixed with user data. **All handler-originated outcomes use HTTP 200 — see the host-side mapping table below for the complete contract.** The earlier "HTTP 422" wire status is RETIRED for handler outcomes; 422 is no longer a valid status from any koi shim.
  - Header is set/verified by the koi-owned shim only; user handler code cannot forge `X-Koi-Result-Kind` because Worker A controls the response headers (it strips any user-set `X-Koi-Result-Kind` before forwarding).
  - This replaces the earlier `{ koi: { failed: true, error } }` body envelope, which collided with the user-defined `output: unknown` contract — a legitimate handler that happened to return `{ koi: { failed: true } }` as its business response would have been reinterpreted as a permanent failure. Out-of-band header discrimination eliminates that ambiguity entirely. References elsewhere in this doc to the legacy envelope mean the new header+koi-owned-error-body model.
- **Host-side mapping (single complete contract — header is authoritative; HTTP status is transport-only):**

  The koi shim ALWAYS returns HTTP 200 for any handler-originated response (success, permanent-failure, transient-error). Business outcome is encoded EXCLUSIVELY in `X-Koi-Result-Kind`. Non-200 statuses are RESERVED for transport-level conditions (TIMEOUT, persistence failure, conflict, true provider error) and are NEVER produced by the handler. This means a handler that wants to express "201 Created" or "404 Not Found" returns it in the body (e.g., `{ status: 201, location: "..." }`) — the wire-level HTTP status is decoupled from the business response. The koi handler-runtime helper (`koi.success(value)`, `koi.failPermanent(error)`) enforces this; user code that constructs a raw `Response` with non-200 status triggers the runtime's `HANDLER_NON_200_FORBIDDEN` reject before the response leaves Worker B.

  | HTTP status | `X-Koi-Result-Kind` header | Host treats as |
  |-------------|----------------------------|----------------|
  | 200 | `success` | `{ ok: true, value: { output: <body parsed as JSON> } }` |
  | 200 | `failed-permanent` | `{ ok: false, error: { code: "HANDLER_PERMANENT_FAILURE", cachedError: <body.error> } }` |
  | 200 | absent | `{ ok: false, error: { code: "MALFORMED_SHIM_RESPONSE" } }` (header is required; absence indicates a buggy or tampered shim) |
  | 504 | `timeout` | `{ ok: false, error: { code: "TIMEOUT" } }` |
  | 503 | `shim-error` | `{ ok: false, error: { code: <body.error or X-Koi-Shim-Error-Code: WAITER_PROTOCOL_BUG \| LEASE_LOST \| OWNERSHIP_LOST \| DEDUPE_PERSISTENCE_FAILED \| RESULT_TOO_LARGE> } }`. Every 503 from a koi shim MUST carry `X-Koi-Result-Kind: shim-error` and `X-Koi-Shim-Error-Code: <subcode>` so the host can surface a typed `KoiError` instead of an opaque 503. Missing header on 503 = `MALFORMED_SHIM_RESPONSE`. |
  | 409 | `operation-id-conflict` | `{ ok: false, error: { code: "OPERATION_ID_CONFLICT", storedFingerprint: <body.storedFingerprint> } }` |
  | 410 | `operation-expired` | `{ ok: false, error: { code: "OPERATION_EXPIRED", dedupeExpiresAtMs: <body.dedupeExpiresAtMs> } }` |
  | other 4xx/5xx | any | `{ ok: false, error: { code: "PROVIDER_ERROR", status, body } }` |

  The earlier "200 + absent header → success (compat)" and "422 + absent header → permanent-failure (compat)" rules are REMOVED. Handler responses MUST carry the koi outcome header; absence is a shim-integrity failure (`MALFORMED_SHIM_RESPONSE`). The shim version is part of the koi-managed deploy artifact, so there is no "older shim" compatibility burden — the adapter and shim ship together. The 422 status code is RETIRED for handler responses (it now denotes only transport-level provider errors). This removes the user-visible compatibility break where a handler returning HTTP 201/204/4xx as a normal business response was being reclassified as `HANDLER_PERMANENT_FAILURE` or `PROVIDER_ERROR`. Adversarial test (mandatory): `__tests__/handler-non-200-rejected.test.ts` covers (a) handler returns raw 201 → runtime rejects with `HANDLER_NON_200_FORBIDDEN`; (b) handler returns 200 without outcome header → host maps to `MALFORMED_SHIM_RESPONSE`; (c) handler uses `koi.success({ status: 201, ... })` → host maps to `{ ok: true, value: { output: { status: 201, ... } } }`.
- **Adversarial test (mandatory):** `__tests__/cf-do-failed-permanent-protocol.test.ts` covers (a) caller A's handler responds with `koi.failPermanent(error)` (which returns HTTP 200 + header `X-Koi-Handler-Outcome: failed-permanent` + body `{ "error": <serialized> }`) — the shim reads the HEADER (NOT the body shape) to commit the DO `failed-permanent` transition; (b) caller B issues `claim` after A committed — asserts `claim` returns `{ status: "failed-permanent", error }` and host maps to `HANDLER_PERMANENT_FAILURE`; (c) caller C issues `claim` while A is still running, then A commits failed-permanent — asserts C's `waitForTerminal` returns the cached error within the polling window (NOT a timeout); (d) **legacy-envelope rejection**: a handler that returns HTTP 200 with body `{ "koi": { "failed": true, "error": ... } }` but WITHOUT `X-Koi-Handler-Outcome` header is treated as a normal success — the body is preserved verbatim and reaches the caller as `output: { koi: { failed: true, error: ... } }`. The DO must NOT transition to `failed-permanent`. This sub-case enforces the user-payload-namespace invariant. Test must pass for every PR that touches the DO claim/wait protocol.
- **Stuck-claim recovery:** if a caller observes `claim-expired` with a non-null result (handler ran but didn't complete the DO), it does NOT trust the partial state. It transitions to `claimed` itself and re-runs the handler. This is the only path where idempotency-at-side-effect-targets matters; the workload-class restriction covers it.

The shim handler:

All dedupe keys are **fleet-namespaced** to prevent cross-tenant collision when multiple deployments share a DO namespace. The effective key is `${ownerId}:${operationId}`, NOT raw `operationId`. Two fleets reusing the same `operationId` value never contend on the same DO instance because their `ownerId` prefixes differ.

```js
const dedupeKey = `${ownerId}:${operationId}`;
const stub = KOI_DEDUPE_DO.get(KOI_DEDUPE_DO.idFromName(dedupeKey));
// dedupeFingerprint binds the dedupe record to the payload so operationId reuse with a different
// payload returns OPERATION_ID_CONFLICT. handlerCodeHash and pairUUID are intentionally excluded.
//
// CANONICALIZATION (mandatory; same algorithm at every call site, host AND shim):
// payloadCanonical = utf8Bytes(jcs(payload)) — RFC 8785 JSON Canonicalization Scheme (JCS),
// then UTF-8 encoded to BYTES. Object keys sorted lexicographically by code-point order;
// numbers normalized per ES6 Number.prototype.toString (no trailing zeros, no +0/-0 distinction);
// no whitespace; strings UTF-16-encoded then UTF-8-output.
//
// FINGERPRINT (normative byte-level algorithm — single authoritative construction):
//   ownerIdBytes = utf8Bytes(ownerId + ":")
//   payloadHash = sha256_raw(payloadCanonical)        // 32 RAW bytes, NOT hex
//   dedupeFingerprint_bytes = sha256_raw(concat(ownerIdBytes, payloadHash))  // 32 RAW bytes
//   dedupeFingerprint = base16Lower(dedupeFingerprint_bytes)  // wire/storage form: lowercase hex
// "Concat" here is byte concatenation, not string interpolation. The inner SHA-256 is consumed as
// RAW digest bytes, not as a hex-text representation. Earlier prose that read like
// `sha256(\`${ownerId}:${sha256(payloadCanonical)}\`)` is non-normative shorthand and is REMOVED;
// the byte-level construction above is the single source of truth, used identically by host,
// Cloudflare shim, and Vercel shim. JCS is normative because two semantically-identical JSON
// values (e.g., {a:1,b:2} vs {b:2,a:1}) MUST produce the same fingerprint.
// Adversarial test (mandatory): __tests__/dedupe-fingerprint-jcs.test.ts asserts (a) {a:1,b:2}
// and {b:2,a:1} produce identical fingerprints, (b) numeric edge cases (0 vs -0, 1.0 vs 1)
// canonicalize identically, (c) the host's bun:test JCS implementation and the shim's bundled
// JCS produce byte-identical fingerprints for a 100-vector corpus, (d) cross-checks the
// host-computed fingerprint against shim-computed fingerprint over the same corpus to prove
// the byte-level construction is consistent.
const dedupeFingerprint = computeDedupeFingerprint(ownerId, payload); // single helper, normative
const claimResult = await stub.fetch("https://do/claim", {
  method: "POST",
  body: JSON.stringify({ operationId, requestId, dedupeFingerprint, dedupeExpiresAtMs }),
});
const claim = await claimResult.json();
// claim.status: "fresh" | "in-progress" | "completed" | "failed-permanent" | "fingerprint-conflict" | "operation-expired"
if (claim.status === "fingerprint-conflict") {
  return new Response(JSON.stringify({ error: "OPERATION_ID_CONFLICT", storedFingerprint: claim.storedFingerprint }), { status: 409, headers: { "X-Koi-Result-Kind": "operation-id-conflict" } });
}
if (claim.status === "operation-expired") {
  return new Response(JSON.stringify({ error: "OPERATION_EXPIRED", dedupeExpiresAtMs }), { status: 410, headers: { "X-Koi-Result-Kind": "operation-expired" } });
}
if (claim.status === "completed") {
  // Always 200; outcome encoded in X-Koi-Result-Kind. claim.statusCode is application-layer only — the handler chose to put it in the body if it cared.
  return new Response(JSON.stringify(claim.result), { status: 200, headers: { "X-Koi-Result-Kind": "success" } });
}
if (claim.status === "failed-permanent") {
  // Cached terminal failure — surface the same error every retry observes. Always 200; outcome via header.
  return new Response(JSON.stringify({ error: claim.error }), { status: 200, headers: { "X-Koi-Result-Kind": "failed-permanent" } });
}
if (claim.status === "in-progress") {
  // poll the DO until it transitions to a TERMINAL status (completed or failed-permanent) or timeout fires
  // SHIM_POLL_DEADLINE_MS is a koi-shim INTERNAL constant (25_000), NOT the caller's waiterTimeoutMs.
  // The caller's waiterTimeoutMs is host-local-only and is NEVER forwarded to Worker A.
  // Worker A bounds its own in-isolate poll at 25s so the host has 5s of remaining waiterTimeoutMs slack
  // for network RTT before the host's 30s default waiter cap fires.
  // waitForTerminal does NOT take expiry as an authorization input. It optionally accepts a
  // requestExpiryClaim used SOLELY for mismatch detection (compared against the ledger's stored
  // originalDedupeExpiresAtMs inside the DO RPC). If the caller passes the request's
  // dedupeExpiresAtMs as requestExpiryClaim, the DO returns operation-id-conflict on mismatch;
  // if the caller omits it, the waiter still enforces hard-cutoff against the ledger but skips
  // the mismatch-detection short-circuit. The waiter NEVER authorizes a wait on the basis of a
  // caller-supplied expiry. Single-contract signature:
  //   waitForTerminal(stub, operationId, requestId, requestExpiryClaim, timeoutMs)
  return await waitForTerminal(stub, operationId, requestId, dedupeExpiresAtMs, SHIM_POLL_DEADLINE_MS);
}
// claim.status === "fresh" — this isolate owns the operation
const result = await handler({ payload, operationId, requestId });
await stub.fetch("https://do/complete", {
  method: "POST",
  // ttlExpiresAtMs and the previously-claimed requestId/dedupeFingerprint are required so the DO
  // can (a) verify the caller still owns the claim, (b) refuse to overwrite a record whose stored
  // fingerprint differs (post-aliasing safety), and (c) schedule the purge alarm at ttlExpiresAtMs.
  body: JSON.stringify({ operationId, requestId, dedupeFingerprint, result, statusCode: 200, ttlExpiresAtMs: dedupeExpiresAtMs + 3_600_000 }),
});
return new Response(JSON.stringify(result), { status: 200, headers: { "X-Koi-Result-Kind": "success" } });
```

Every shim response — fresh-owner success, terminal-cache hit, waiter-completed, waiter-failed, timeout, conflict, expired — sets `X-Koi-Result-Kind` per the host-mapping table. Absent header = `MALFORMED_SHIM_RESPONSE`. There is no compat fallback.

The DO class implements `claim` atomically (single-threaded execution per object id), guarantees only one isolate transitions a key to `in-progress`, and persists results to its built-in transactional storage until `dedupeExpiresAtMs + 1h`. **`waitForTerminal(stub, operationId, requestId, requestExpiryClaim, timeoutMs)` reads expiry from the LEDGER ROW on every poll iteration — it does NOT trust the `requestExpiryClaim` argument as an authorization input.** The `requestExpiryClaim` parameter exists ONLY so the DO RPC can compare it against the ledger's stored `originalDedupeExpiresAtMs` and short-circuit with `operation-id-conflict` on mismatch. The waiter NEVER extends or accepts a wait on the basis of `requestExpiryClaim`; hard-cutoff and timing decisions come from the ledger only. Each poll RPC to the DO reads `(ledger.originalDedupeExpiresAtMs, terminalRecord?)` together in a single transaction; if `Date.now() > ledger.originalDedupeExpiresAtMs`, the function returns `{ kind: "operation-expired" }` immediately, regardless of whether a terminal record exists (consistent with the hard-cutoff rule above). If the request that entered the waiter carried a `dedupeExpiresAtMs` that differs from `ledger.originalDedupeExpiresAtMs` by more than the small skew tolerance, the DO RPC returns `{ kind: "operation-id-conflict", reason: "EXPIRY_HORIZON_MISMATCH" }` BEFORE any further polling — the waiter cannot extend or bypass the stored horizon. The shim maps to 410 + `X-Koi-Result-Kind: operation-expired` (or 409 + `operation-id-conflict` for mismatch). The earlier draft's signature treated `dedupeExpiresAtMs` as authoritative for the wait deadline; that was the gap that allowed forward-shifted expiry to extend the wait. The corrected signature carries it as `requestExpiryClaim` (a non-authoritative mismatch-detection input only) and the wait deadline comes from the ledger. **Adversarial tests (mandatory):** `__tests__/cf-waiter-expiry-fail-closed.test.ts` starts a waiter against an existing ledger row whose `originalDedupeExpiresAtMs` is in the near future, kills the owning isolate, and asserts the waiter returns `operation-expired` past the LEDGER's horizon rather than attempting takeover. `__tests__/cf-waiter-rejects-shifted-expiry.test.ts` issues a retry that lands in the waiter path with a forward-shifted `dedupeExpiresAtMs` and asserts the waiter rejects with `OPERATION_ID_CONFLICT/EXPIRY_HORIZON_MISMATCH`, not a successful late completion. Cross-instance retries (after `destroy()` + new `create()`) hit the same DO id (because `operationId` keys the lookup) and observe the prior outcome subject to the same ledger-anchored expiry rule.

#### Vercel: Vercel KV (Upstash Redis) with `SET NX EX`

`createVercelAdapter` REQUIRES `config.dedupeKvUrl: string` and `config.dedupeKvToken: string` — a Vercel KV connection (Upstash Redis-compatible REST API). Vercel Edge Config is read-only and write-async, so it cannot serve as a dedupe store. Vercel KV uses Redis primitives which support strongly-consistent `SET NX EX` (set if not exists, with expiry) — the operation is atomic on a single key. The adapter wires the connection as bindings `KOI_DEDUPE_KV_URL` and `KOI_DEDUPE_KV_TOKEN` so the shim can issue authenticated requests.

**Dedupe state machine** (parallels the Cloudflare DO design):

All Vercel KV keys are **fleet-namespaced** with `ownerId` to prevent cross-tenant collision when multiple deployments share a KV instance. The shim manages three keys per `operationId`, all prefixed by `ownerId`:

- `${ownerId}:claim:${operationId}` — holds the active claimer's `requestId` with a **15-second TTL** (heartbeat lease — sized below the 30s invoke timeout so waiters can reclaim a crashed owner's claim within the same invoke window).
- `${ownerId}:result:${operationId}` — holds the cached result with TTL = `(dedupeExpiresAtMs + 1h) - now` (1-hour grace beyond expiry for storage purposes ONLY; serving past expiry is governed by the ledger and is forbidden — see hard-cutoff rule).
- `${ownerId}:failed:${operationId}` — cached terminal failures with the same TTL formula.
- `${ownerId}:fingerprint:${operationId}` — durable `dedupeFingerprint = sha256("${ownerId}:${sha256(payload)}")` for the first attempt that ever wrote claim/result/failed under this `operationId`. TTL matches the terminal records. **Excludes both per-instance identity (`pairUUID`) and `handlerCodeHash`** so retries across destroy/recreate AND across routine handler rollouts compute the same fingerprint and observe the prior terminal record. Identical fingerprint definition to the Cloudflare DO model — host-side mapping is provider-symmetric. Handler-version drift is logged as `KOI_HANDLER_VERSION_DRIFT` telemetry but does NOT cause a conflict.
- `${ownerId}:ledger:${operationId}` — **immutable per-operation ledger row, mirror of the Cloudflare ledger.** Written exactly once at first claim; carries `{ firstClaimAtMs, originalDedupeExpiresAtMs, originalDedupeFingerprint }`. TTL = `30 days + 1 hour - (now - firstClaimAtMs)` so retention dominates the result/failed/claim/fingerprint records. Every claim/wait path consults the ledger BEFORE any result/failed lookup; a present ledger with `now > originalDedupeExpiresAtMs` produces `operation-expired` regardless of whether a cached result still exists. A request whose `dedupeExpiresAtMs` differs from the stored `originalDedupeExpiresAtMs` by more than skew tolerance is rejected as `fingerprint-conflict:EXPIRY_HORIZON_MISMATCH`. Without this row, a Vercel-side caller could resend `operationId` with a forward-shifted expiry after the result/fingerprint TTLs aged out and obtain fresh execution — exactly the post-purge forge path the Cloudflare ledger closed.

Two fleets reusing the same `operationId` value never contend because their key prefixes differ. The shim reads `ownerId` from a worker env var (`KOI_OWNER_ID`) injected at deploy time by the koi adapter, NOT from the request — clients cannot spoof a different owner.

Atomic operations via Upstash Redis pipelined commands:

```js
// All keys fleet-namespaced via ownerId from KOI_OWNER_ID env var (set by adapter at deploy)
const ns = KOI_OWNER_ID; // injected at deploy time
const claimKey = `${ns}:claim:${operationId}`;
const resultKey = `${ns}:result:${operationId}`;
const failedKey = `${ns}:failed:${operationId}`;
const fingerprintKey = `${ns}:fingerprint:${operationId}`;
const ledgerKey = `${ns}:ledger:${operationId}`;

// dedupeFingerprint: identical definition to Cloudflare DO.
// pairUUID and handlerCodeHash are INTENTIONALLY EXCLUDED — see CF DO section for rationale.
// Identical normative algorithm as the CF DO section above:
//   sha256_raw(utf8Bytes(ns + ":") || sha256_raw(utf8Bytes(jcs(payload)))) → base16Lower
// Same shared `computeDedupeFingerprint(ownerId, payload)` helper is used by host AND shim.
const dedupeFingerprint = computeDedupeFingerprint(ns, payload);

// 1+2. Atomic check-or-claim via single Lua EVAL (no race window between check and claim).
// Fingerprint is checked FIRST and atomically: if a record exists for this operationId with a
// different fingerprint, the request is rejected as a fingerprint-conflict — never silently
// served a stale-aliased result. If no fingerprint exists yet (fresh op), the claim writes both
// the claim and the fingerprint atomically so subsequent attempts can be compared.
// Returns one of:
//   "fingerprint-conflict:<storedFingerprint>"
//   "operation-expired"
//   "result:<json>"
//   "failed:<json>"
//   "claim:fresh"
//   "claim:in-progress:<requestId>"
//
// Argument order: ARGV[1]=requestId, ARGV[2]=dedupeFingerprint, ARGV[3]=retentionSec,
// ARGV[4]=nowMs, ARGV[5]=dedupeExpiresAtMs, ARGV[6]=ledgerRetentionSec, ARGV[7]=skewToleranceMs.
// LEDGER-FIRST ordering (matches CF DO and the hard-cutoff rule):
//  1. Read ledger row. If present:
//     a. If request's dedupeExpiresAtMs differs from stored originalDedupeExpiresAtMs by > skew → fingerprint-conflict:EXPIRY_HORIZON_MISMATCH.
//     b. If now > stored originalDedupeExpiresAtMs → operation-expired (regardless of result/failed presence).
//  2. Else: read fingerprint key (legacy aliasing protection).
//  3. Only AFTER ledger and fingerprint pass: read result/failed.
//  4. Else: try claim. If fresh, write ledger row + fingerprint atomically as part of the claim transaction.
const CHECK_OR_CLAIM_LUA = `
  local ledger = redis.call('GET', KEYS[5])
  if ledger then
    local sep = string.find(ledger, ':')
    local origExpiry = tonumber(string.sub(ledger, 1, sep - 1))
    local origFp = string.sub(ledger, sep + 1)
    if origFp ~= ARGV[2] then return 'fingerprint-conflict:'..origFp end
    if math.abs(tonumber(ARGV[5]) - origExpiry) > tonumber(ARGV[7]) then
      return 'fingerprint-conflict:EXPIRY_HORIZON_MISMATCH:'..origExpiry
    end
    if tonumber(ARGV[4]) > origExpiry then return 'operation-expired' end
    local r = redis.call('GET', KEYS[1])
    if r then return 'result:'..r end
    local f = redis.call('GET', KEYS[2])
    if f then return 'failed:'..f end
    local c = redis.call('GET', KEYS[3])
    if c then return 'claim:in-progress:'..c end
    redis.call('SET', KEYS[3], ARGV[1], 'EX', '15')
    return 'claim:fresh'
  end
  -- No ledger yet → first-ever claim for this operationId.
  -- Atomic single-winner first-claim: SET ledger NX EX. Only the writer that wins the SET-NX
  -- proceeds to write claim/fingerprint and return claim:fresh. A loser observes the winner's
  -- ledger and recurses into the ledger branch on its next call.
  -- (Redis Lua is single-threaded so any two EVALs serialize; the SET NX is belt-and-braces
  -- against any future provider whose EVAL semantics deviate from CRedis.)
  if tonumber(ARGV[4]) > tonumber(ARGV[5]) then return 'operation-expired' end
  local ledgerWon = redis.call('SET', KEYS[5], tostring(ARGV[5])..':'..ARGV[2], 'NX', 'EX', ARGV[6])
  if not ledgerWon then
    -- Lost the race. Re-read the ledger and apply ledger-branch logic.
    local now = redis.call('GET', KEYS[5])
    local sep2 = string.find(now, ':')
    local origExpiry2 = tonumber(string.sub(now, 1, sep2 - 1))
    local origFp2 = string.sub(now, sep2 + 1)
    if origFp2 ~= ARGV[2] then return 'fingerprint-conflict:'..origFp2 end
    if math.abs(tonumber(ARGV[5]) - origExpiry2) > tonumber(ARGV[7]) then
      return 'fingerprint-conflict:EXPIRY_HORIZON_MISMATCH:'..origExpiry2
    end
    if tonumber(ARGV[4]) > origExpiry2 then return 'operation-expired' end
    local r2 = redis.call('GET', KEYS[1])
    if r2 then return 'result:'..r2 end
    local f2 = redis.call('GET', KEYS[2])
    if f2 then return 'failed:'..f2 end
    local c2 = redis.call('GET', KEYS[3])
    if c2 then return 'claim:in-progress:'..c2 end
    -- No claim and no terminal — winner crashed before writing claim. Recover by becoming claimer.
    redis.call('SET', KEYS[3], ARGV[1], 'EX', '15')
    return 'claim:fresh'
  end
  -- Ledger SET-NX won — we are the single legitimate first claimer.
  redis.call('SET', KEYS[3], ARGV[1], 'EX', '15')
  redis.call('SET', KEYS[4], ARGV[2], 'EX', ARGV[3])
  return 'claim:fresh'
`;
const initialRetentionSec = Math.floor((dedupeExpiresAtMs + 3_600_000 - Date.now()) / 1000);
const ledgerRetentionSec = Math.floor((30 * 86400 + 3600)); // 30 days + 1h grace, written once at first claim
const SKEW_TOLERANCE_MS = 1000;
const checkResult = await kvCommand("EVAL", [CHECK_OR_CLAIM_LUA, "5", resultKey, failedKey, claimKey, fingerprintKey, ledgerKey, requestId, dedupeFingerprint, String(initialRetentionSec), String(Date.now()), String(dedupeExpiresAtMs), String(ledgerRetentionSec), String(SKEW_TOLERANCE_MS)]);
if (checkResult === "operation-expired") {
  return new Response(JSON.stringify({ error: "OPERATION_EXPIRED", dedupeExpiresAtMs }), { status: 410, headers: { "X-Koi-Result-Kind": "operation-expired" } });
}
if (checkResult.startsWith("fingerprint-conflict:")) {
  // operationId was reused with a different payload OR handler version. Reject loudly — never
  // serve a stale-aliased result. Host-side adapter maps this to KoiError { code: "OPERATION_ID_CONFLICT" }.
  return new Response(JSON.stringify({ error: "OPERATION_ID_CONFLICT", storedFingerprint: checkResult.slice("fingerprint-conflict:".length) }), { status: 409, headers: { "X-Koi-Result-Kind": "operation-id-conflict" } });
}
if (checkResult.startsWith("result:")) {
  return new Response(checkResult.slice("result:".length), { status: 200, headers: { "X-Koi-Result-Kind": "success" } });
}
if (checkResult.startsWith("failed:")) {
  // Always 200 — outcome carried in X-Koi-Result-Kind. Mapping is identical for both providers.
  const error = JSON.parse(checkResult.slice("failed:".length));
  return new Response(JSON.stringify({ error }), { status: 200, headers: { "X-Koi-Result-Kind": "failed-permanent" } });
}
let claimGranted = checkResult === "claim:fresh";
if (checkResult.startsWith("claim:in-progress:")) {
  // Another isolate owns it. waitForTerminal returns a TAGGED result:
  //   { kind: "completed", body }         → return body to caller
  //   { kind: "failed", body }            → return body with 200 + X-Koi-Result-Kind: failed-permanent header
  //   { kind: "takeover" }                → fall through; this isolate now holds the claim, run handler
  //   { kind: "timeout" }                 → return 504 to caller
  // SHIM_POLL_DEADLINE_MS = 25_000 is the koi-shim INTERNAL bound; NOT the caller's waiterTimeoutMs.
  // waitForTerminal reads expiry from the LEDGER on every poll — it does NOT trust the request's dedupeExpiresAtMs.
  // dedupeExpiresAtMs is passed only so the waiter can detect EXPIRY_HORIZON_MISMATCH on each poll and short-circuit
  // with operation-id-conflict (matches CF DO behavior). If now > ledger.originalDedupeExpiresAtMs at any poll,
  // the waiter returns { kind: "operation-expired" } regardless of result/failed key presence.
  const wait = await waitForTerminal(resultKey, failedKey, claimKey, fingerprintKey, ledgerKey, requestId, dedupeFingerprint, dedupeExpiresAtMs, SHIM_POLL_DEADLINE_MS);
  // EVERY tagged outcome handled explicitly. Unknown kinds are a fatal protocol bug, not a takeover.
  if (wait.kind === "completed") return new Response(wait.body, { status: 200, headers: { "X-Koi-Result-Kind": "success" } });
  if (wait.kind === "failed") return new Response(wait.body, { status: 200, headers: { "X-Koi-Result-Kind": "failed-permanent" } });
  if (wait.kind === "timeout") return new Response(JSON.stringify({ error: "TIMEOUT" }), { status: 504, headers: { "X-Koi-Result-Kind": "timeout" } });
  if (wait.kind === "operation-expired") return new Response(JSON.stringify({ error: "OPERATION_EXPIRED", dedupeExpiresAtMs }), { status: 410, headers: { "X-Koi-Result-Kind": "operation-expired" } });
  if (wait.kind === "operation-id-conflict") return new Response(JSON.stringify({ error: "OPERATION_ID_CONFLICT", storedFingerprint: wait.storedFingerprint }), { status: 409, headers: { "X-Koi-Result-Kind": "operation-id-conflict" } });
  if (wait.kind === "takeover") { claimGranted = true; }
  else {
    // Unknown wait kind. Fail closed — never silently take over.
    console.error("DEDUPE_WAITER_UNKNOWN_KIND", { kind: (wait as { kind: string }).kind });
    return new Response(JSON.stringify({ error: "WAITER_PROTOCOL_BUG" }), { status: 503, headers: { "X-Koi-Result-Kind": "shim-error", "X-Koi-Shim-Error-Code": "WAITER_PROTOCOL_BUG" } });
  }
}
// claimGranted === true — we own the operation (either fresh or via takeover)

// 3. Spawn heartbeat: every 30s, ownership-checked TTL extension via Lua EVAL
//    Lua: extend TTL ONLY IF the current value still matches our requestId.
const HEARTBEAT_LUA = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('EXPIRE', KEYS[1], ARGV[2])
  else
    return 0
  end
`;
let lostLease = false;
// Heartbeat MUST fire well before the 15s lease expires; 5s gives 3-of-3 standard tolerance.
const heartbeat = setInterval(async () => {
  const result = await kvCommand("EVAL", [HEARTBEAT_LUA, "1", claimKey, requestId, "15"]);
  if (result === 0) {
    // We no longer own the claim. Some other isolate has taken it (lease expired and got reclaimed).
    // Stop the heartbeat and POISON ourselves — the in-flight handler must NOT commit results.
    lostLease = true;
    clearInterval(heartbeat);
  }
}, 5_000);

try {
  // handler() invokes Worker B and returns { outcome, body } where:
  //   outcome === "success"           — commit success path (COMMIT_LUA)
  //   outcome === "failed-permanent"  — commit fail path (FAIL_LUA), parity with Cloudflare DO
  //   outcome === "transient"         — release claim (RELEASE_LUA), do NOT cache; retries rerun
  // outcome is read from the `X-Koi-Handler-Outcome` response header set by Worker B's koi runtime
  // (`koi.failPermanent(error)` returns a Response with `X-Koi-Handler-Outcome: failed-permanent`).
  // Worker A NEVER reads the body to discriminate outcomes — header-only, parity with the CF design.
  const { outcome, body } = await handler({ payload, operationId, requestId });
  clearInterval(heartbeat);
  if (lostLease) {
    // We ran handler but our lease was stolen mid-flight. We must not commit — another isolate
    // is now authoritative. Log that side effects MAY have leaked (workload-class accepts this) and return.
    console.warn("DEDUPE_LEASE_LOST_DURING_HANDLER", { operationId, requestId });
    return new Response(JSON.stringify({ error: "LEASE_LOST" }), { status: 503, headers: { "X-Koi-Result-Kind": "shim-error", "X-Koi-Shim-Error-Code": "LEASE_LOST" } });
  }

  // FAILED-PERMANENT path AND oversized-result path both use FAIL_LUA — hoisted here so the
  // success branch's oversized-result handling can also reuse it.
  // retentionSec = (dedupeExpiresAtMs + 3_600_000 - now) / 1000 — the caller-supplied retry horizon plus 1h grace.
  const retentionSec = Math.floor((dedupeExpiresAtMs + 3_600_000 - Date.now()) / 1000);
  const FAIL_LUA = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
      redis.call('DEL', KEYS[1])
      return 1
    else
      return 0
    end
  `;

  if (outcome === "failed-permanent") {
    const failedJson = body; // body = JSON-encoded error envelope from Worker B
    const failCommitted = await kvCommand("EVAL", [FAIL_LUA, "2", claimKey, failedKey, requestId, failedJson, String(retentionSec)]);
    if (failCommitted === 0) {
      console.warn("DEDUPE_OWNERSHIP_LOST_AT_FAIL_COMMIT", { operationId, requestId });
      return new Response(JSON.stringify({ error: "OWNERSHIP_LOST" }), { status: 503, headers: { "X-Koi-Result-Kind": "shim-error", "X-Koi-Shim-Error-Code": "OWNERSHIP_LOST" } });
    }
    return new Response(failedJson, { status: 200, headers: { "X-Koi-Result-Kind": "failed-permanent" } });
  }

  if (outcome === "transient") {
    // Retryable handler error. Per the documented contract: do NOT cache; retries must rerun.
    // Ownership-checked claim release — never delete a claim that has rotated to a different owner.
    // Adversarial test: __tests__/vercel-transient-not-cached.test.ts (a) handler returns
    // X-Koi-Handler-Outcome: transient, (b) asserts no resultKey/failedKey is written, (c) asserts
    // a follow-up retry against the same operationId runs the handler again (no cached value).
    const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
    await kvCommand("EVAL", [RELEASE_LUA, "1", claimKey, requestId]);
    const transientErrorJson = body; // body = JSON-encoded error envelope from Worker B
    return new Response(transientErrorJson, { status: 503, headers: { "X-Koi-Result-Kind": "shim-error", "X-Koi-Shim-Error-Code": "HANDLER_TRANSIENT", "Retry-After": "1" } });
  }

  // 4. Atomic ownership-checked commit via Lua EVAL: write result + delete claim ONLY IF still owned.
  const COMMIT_LUA = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
      redis.call('DEL', KEYS[1])
      return 1
    else
      return 0
    end
  `;
  const resultJson = body; // outcome === "success"; body is JSON-encoded handler output
  // Use UTF-8 ENCODED byte length, NOT JS string code-unit length. A multibyte payload that
  // passes a string-length check can still exceed the wire/KV limit. TextEncoder is the
  // authoritative measurement for the actual KV/HTTP write size.
  const resultBytes = new TextEncoder().encode(resultJson).byteLength;
  if (resultBytes > MAX_DEDUPE_RESULT_BYTES /* = 8 MB encoded UTF-8 bytes, configurable */) {
    // Result too large to cache durably. Handler side effects already happened, so persist
    // a TERMINAL failed-permanent record (RESULT_TOO_LARGE_PERMANENT) via FAIL_LUA so retries
    // observe a cached outcome rather than re-running the handler.
    const tooLargeError = JSON.stringify({ error: "RESULT_TOO_LARGE_PERMANENT", maxBytes: MAX_DEDUPE_RESULT_BYTES, observedBytes: resultBytes });
    const failCommitted = await kvCommand("EVAL", [FAIL_LUA, "2", claimKey, failedKey, requestId, tooLargeError, String(retentionSec)]);
    if (failCommitted === 0) {
      console.warn("DEDUPE_OWNERSHIP_LOST_AT_TOO_LARGE_COMMIT", { operationId, requestId });
      return new Response(JSON.stringify({ error: "OWNERSHIP_LOST" }), { status: 503, headers: { "X-Koi-Result-Kind": "shim-error", "X-Koi-Shim-Error-Code": "OWNERSHIP_LOST" } });
    }
    console.error("DEDUPE_RESULT_TOO_LARGE_PERMANENT", { operationId, size: resultJson.length });
    return new Response(tooLargeError, { status: 200, headers: { "X-Koi-Result-Kind": "failed-permanent" } });
  }
  const committed = await kvCommand("EVAL", [COMMIT_LUA, "2", claimKey, resultKey, requestId, resultJson, String(retentionSec)]);
  if (committed === 0) {
    // Lost ownership between handler completion and commit attempt. Don't write result; another
    // isolate will produce its own result. Side effects may have leaked (workload-class accepts).
    console.warn("DEDUPE_OWNERSHIP_LOST_AT_COMMIT", { operationId, requestId });
    return new Response(JSON.stringify({ error: "OWNERSHIP_LOST" }), { status: 503, headers: { "X-Koi-Result-Kind": "shim-error", "X-Koi-Shim-Error-Code": "OWNERSHIP_LOST" } });
  }
  return new Response(resultJson, { status: 200, headers: { "X-Koi-Result-Kind": "success" } });
} catch (err) {
  clearInterval(heartbeat);
  // Don't cache transient handler errors. Ownership-checked DEL only.
  const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
  await kvCommand("EVAL", [RELEASE_LUA, "1", claimKey, requestId]);
  throw err;
}
```

**Vercel `waitForTerminal` reclaim protocol (parity with Cloudflare's claim-expired takeover):**

```js
// Tagged result discriminated on `kind`. Caller branches explicitly.
async function waitForTerminal(resultKey, failedKey, claimKey, fingerprintKey, ledgerKey, requestId, dedupeFingerprint, dedupeExpiresAtMs, shimPollDeadlineMs) {
  const start = Date.now();
  const POLL_MS = 1000;
  while (Date.now() - start < shimPollDeadlineMs) {
    // LEDGER-FIRST. The earlier draft did standalone GETs on resultKey/failedKey before
    // consulting the ledger; that path could return a cached terminal value past the
    // ledger's originalDedupeExpiresAtMs and silently violate the hard-cutoff rule.
    // Removed. Every poll iteration goes through CHECK_OR_CLAIM_LUA, which performs
    // ledger-first ordering atomically (expiry/horizon-mismatch checked BEFORE result/failed).
    // Atomically check ledger, claim, AND terminal keys in one Lua script — terminal results
    // that appeared between polls are returned by CHECK_OR_CLAIM_LUA only AFTER the ledger
    // confirms the operation has not expired and the request's dedupeExpiresAtMs matches the
    // stored originalDedupeExpiresAtMs. There is NO standalone GET on resultKey/failedKey.
    // are returned by CHECK_OR_CLAIM_LUA and MUST be honored, not ignored.
    const reclaimRetentionSec = Math.floor((dedupeExpiresAtMs + 3_600_000 - Date.now()) / 1000);
    const reclaimLedgerRetentionSec = Math.floor((30 * 86400 + 3600));
    const SKEW_TOLERANCE_MS = 1000;
    // The waiter path MUST call the same ledger-aware contract as the initial claim path.
    // Same KEYS arity (5), same ARGV arity (7). Ledger-first ordering applies on every reclaim
    // attempt: a present ledger row enforces hard-cutoff and EXPIRY_HORIZON_MISMATCH BEFORE
    // any takeover. This is the single source of truth for expiry/conflict in the waiter path.
    const reclaim = await kvCommand("EVAL", [CHECK_OR_CLAIM_LUA, "5", resultKey, failedKey, claimKey, fingerprintKey, ledgerKey, requestId, dedupeFingerprint, String(reclaimRetentionSec), String(Date.now()), String(dedupeExpiresAtMs), String(reclaimLedgerRetentionSec), String(SKEW_TOLERANCE_MS)]);
    if (reclaim === "operation-expired") return { kind: "operation-expired" };
    if (reclaim.startsWith("fingerprint-conflict:")) {
      // Cannot happen for a legitimate waiter — would mean operationId aliased mid-wait. Surface loudly.
      return { kind: "operation-id-conflict", storedFingerprint: reclaim.slice("fingerprint-conflict:".length) };
    }
    if (reclaim.startsWith("result:")) {
      return { kind: "completed", body: reclaim.slice("result:".length) };
    }
    if (reclaim.startsWith("failed:")) {
      const error = JSON.parse(reclaim.slice("failed:".length));
      return { kind: "failed", body: JSON.stringify({ error }) };
    }
    if (reclaim === "claim:fresh") {
      // Lease expired AND we won the SETNX — caller runs the handler under our own claim.
      return { kind: "takeover" };
    }
    // reclaim startsWith "claim:in-progress:" — still in progress under same or different requestId; keep polling.
    await sleep(POLL_MS);
  }
  return { kind: "timeout" };
}
```

**Adversarial tests (mandatory) for the waiter ledger-first contract:** `__tests__/vercel-waiter-rejects-shifted-expiry.test.ts` issues a retry that loses the claim race and enters the waiter path with a forward-shifted `dedupeExpiresAtMs`; asserts the waiter returns `operation-id-conflict` (mapping to `OPERATION_ID_CONFLICT/EXPIRY_HORIZON_MISMATCH`), not a successful late completion. `__tests__/vercel-waiter-expiry-fail-closed.test.ts` enters the waiter path against a ledger whose `originalDedupeExpiresAtMs` is in the near future, kills the claim owner so the waiter would otherwise take over, and asserts the waiter returns `operation-expired` past the ledger's horizon rather than executing under takeover.

**Claim-lease timing must permit reclaim under the host invoke timeout.** The host-side `invoke()` `timeoutMs` defaults to 30_000ms (and is the documented profile cap). For takeover to be feasible inside that envelope, the claim lease MUST expire before the waiter's host timeout fires. The Vercel claim-key parameters are therefore set as:
- Claim-lease TTL: **15 seconds** (down from the earlier 60s — that was incompatible with the 30s invoke cap).
- Owner heartbeat cadence: **5 seconds** (3-of-3 standard tolerance).
- Up to 2 consecutive heartbeat failures (~10 s) tolerated before the owner forfeits ownership.
- Net: a crashed owner's claim-lease expires within at most 15 seconds, the next waiter polling tick (1s after expiry) atomically takes over, and the new owner has the 10-second handler budget (plus reclaim/commit RTT slack — see the timeout-budget breakdown in the host-timeout section) within the 30s invoke window. Handlers that need longer than 10 seconds end-to-end MUST NOT be deployed; the L2 doc states this and the profile-validation table enforces it via `TIMEOUT_EXCEEDS_RECLAIM_BUDGET`.

**`__tests__/vercel-claim-takeover.test.ts` is mandatory:** spawn a stub that calls `claim`, kills the process before commit; a concurrent waiter must take over within 15–16 seconds (the claim-lease TTL + one polling tick) AND produce a terminal record before the 30s invoke timeout fires.

Rules mirror the Cloudflare design:
- Strong consistency via Redis `SET NX` for the claim and `MGET` for the terminal-cache check.
- 15-second lease with 5-second heartbeat (sized below the 30s host invoke timeout so waiters can reclaim within one invoke window). **All heartbeat, commit, and release operations use ownership-checked Lua scripts** that compare the current value of `claim:${operationId}` against this isolate's `requestId` before mutating anything. A stale claimer whose lease expired and was re-acquired by another isolate cannot extend its lease, write results, or delete the new owner's claim — the Lua script's `GET == ARGV[1]` guard fails and the operation returns 0.
- **Lease loss → poison and abort:** if the heartbeat detects ownership loss mid-handler, the isolate marks `lostLease = true`, clears the heartbeat, and returns a `503 LEASE_LOST` response WITHOUT writing any result or releasing the claim. The new owner's state is preserved untouched. The handler may already have committed external side effects — that risk is covered by the workload-class restriction.
- **Commit ownership check:** the final write of `result` and `DEL` of `claim` is a single atomic Lua `EVAL`. If ownership has been lost in the gap between handler completion and commit attempt, the script returns 0 and the isolate returns `503 OWNERSHIP_LOST` without polluting the new owner's state.
- Result writes use POST body, not URL path, to handle arbitrary size up to a configurable `MAX_DEDUPE_RESULT_BYTES` (default 8 MB).
- **Persistence failures fail closed** — same as Cloudflare DO. If `commit` returns 0 (ownership lost) OR the network call fails after retries OR the result exceeds `MAX_DEDUPE_RESULT_BYTES`, the shim returns `503` to the caller WITHOUT serving a success. The handler's side effects already happened (the operator's idempotency contract handles that), but the caller is told the operation did not durably commit. There is no path where the adapter reports `200` without a terminal record persisted.

**Adversarial test (mandatory):** `__tests__/vercel-dedupe-lease-race.test.ts` spawns two stubbed shim invocations with the same `operationId`. Test scenarios:
1. Isolate A claims, then sleeps past lease TTL (simulated via fake timers).
2. Isolate B claims successfully (A's lease expired).
3. Isolate A wakes up and attempts heartbeat → assert it detects ownership loss and returns `LEASE_LOST` without mutating any key.
4. Isolate A attempts commit → assert the Lua script returns 0 and no key is mutated.
5. Isolate B completes normally → assert its result is the only one cached, its claim is the only one cleared.

CI runs this on every PR that touches the Vercel dedupe code; the test fails if any of A's late operations succeed.

#### No opt-out

There is no `dedupeReadOptional` flag. Bypassing the dedupe store would defeat the only mechanical safety the adapter provides. Operators who have audited their handlers as idempotent at the side-effect target can still use the adapter — they just pay the dedupe-store roundtrip on every invoke. The cost is the price of correctness for retried invocations.

#### `assertIdempotent: true` is NOT in v1

The flag belongs to the deferred class-B workload. v1 does not expose it — class A handlers are pure functions of `payload` and need no idempotency attestation because there are no side effects to attest about. Construction does not accept `assertIdempotent` as a config field in v1. Any earlier reference in this doc to `assertIdempotent` describes deferred class-B work and should not be implemented in v1. The future class-B PR will reintroduce the flag together with the wrappers and enforcement story.

A future `sandbox-cloudflare-kv-only` package can offer cheaper KV-backed best-effort dedupe for cost-sensitive workloads that accept eventual consistency; that is out of scope here. This PR ships strongly-consistent dedupe only.

### Kernel / runtime integration path

The CLAUDE.md golden-query rule requires every new L2 package to be wired into `@koi/runtime`. Because `EdgeFunctionAdapter` is not a `SandboxAdapter`, this PR explicitly extends `@koi/core`, `@koi/engine`, `@koi/runtime`, and the CI scripts. The integration is bounded but NOT trivial — the spec enumerates every API addition concretely so reviewers can audit the actual scope:

**`@koi/core` additions (L0, types-only — preserves L0 invariant):**

- New file `packages/kernel/core/src/edge-function-adapter.ts` defining: `EdgeFunctionAdapter`, `EdgeFunctionInstance`, `EdgeInvokeRequest`, `EdgeInvokeResult`, `DestroyOutcome`. Pure interfaces, zero runtime logic. ~80 LOC.
- New entry point `packages/kernel/core/src/index.ts` re-exports the types under the `edge` namespace.

**`@koi/engine` additions (L1):**

- `packages/kernel/engine/src/types.ts` — extend `CreateKoiOptions` with new optional fields:
  ```ts
  export interface CreateKoiOptions {
    // ... existing fields ...
    readonly sandbox?: SandboxAdapter;
    readonly edgeAdapters?: {
      readonly cloudflare?: EdgeFunctionAdapter;
      // vercel?: deliberately omitted — Vercel adapter is design-only in this release.
      // Adding the slot here would create a stable public API surface that has to
      // be supported even if PR 5's promotion criteria are never met. The slot
      // is added only when Vercel is promoted to a published runtime-integrated package.
    };
  }
  ```
  Note: `sandbox` field also does not yet exist on `CreateKoiOptions` per current `packages/kernel/engine/src/types.ts`. Adding both `sandbox` and `edgeAdapters` is part of this PR. ~25 LOC.
- `packages/kernel/engine/src/koi.ts` — extend the runtime constructor to expose the registered Cloudflare adapter under a typed `koi.edge.cloudflare` accessor. **`koi.edge.vercel` is NOT added in PR 2** — it is reserved for PR 5's promotion event. The accessor type permits future extension without breaking existing consumers. ~30 LOC.
- Engine assembly tests assert the slots are reachable when populated and absent (typed `undefined`) when not. ~50 LOC.

**`@koi/runtime` additions (L3 meta):**

- `packages/meta/runtime/src/index.ts` — the runtime convenience bundle re-exports the new edge adapter types and provides a no-default-adapters factory. The Cloudflare adapter is opt-in; the runtime does NOT bundle it by default since it requires API tokens. **No Vercel re-export — Vercel is design-only in this release and stays out of the runtime convenience bundle entirely.** ~20 LOC.
- New test `packages/meta/runtime/src/__tests__/golden-edge-replay.test.ts` — replays recorded Cloudflare API responses (cassettes) against `createCloudflareAdapter` with mocked `fetch`. Asserts the full `create → invoke → destroy` happy path produces the expected ATIF trajectory. **No Vercel cassette in this PR.** ~150 LOC.
- New script `packages/meta/runtime/scripts/record-edge-cassettes.ts` — records cassettes against the real (or stubbed) Cloudflare API for the golden replay. **Vercel recording deferred to PR 5.** ~120 LOC.

**CI script changes:**

- `scripts/check-golden-queries.ts` — currently grep-based on package names (per `scripts/check-golden-queries.ts:52-100`). Extension: parse each L2 package's `package.json` for `koi.adapter-kind` field (`"sandbox"` | `"edge-cloudflare"` | `"edge-vercel"` | `null`). Edge packages are required to land assertions in `golden-edge-replay.test.ts` instead of `golden-replay.test.ts`. The check is symmetric: a package with `adapter-kind: "edge-cloudflare"` is a CI failure if it doesn't appear in the edge replay. ~80 LOC of script changes plus the `package.json` field across all sandbox packages.
- `scripts/check-orphans.ts` — currently checks every L2 is a static dep of `@koi/runtime`. Extension: edge adapters must also be in `@koi/runtime`'s dependencies but are ALLOWED to be unused by `createKoi()`'s default factory (since they're opt-in). The orphan check inspects `package.json` `koi.adapter-kind` to differentiate. ~40 LOC.

**`docs/L3/sandbox-stack.md` update:**

- Add a new "Edge function adapters" subsection documenting the `EdgeFunctionAdapter` contract.
- Update the Cloudflare/Vercel rows in the existing tables to point to the new contract.
- Note that `@koi/sandbox-router` does NOT route to these adapters. ~60 LOC of doc changes.

**Total integration delta:** ~665 LOC of NEW code outside the three sandbox packages themselves, plus the doc update. This is materially larger than "30 LOC of script changes" — the spec budgets accordingly. The figure is included in the overall PR LOC budget below.

The integration path is explicit and bounded but not small. No router changes, no `SandboxAdapter` reshaping.

## Package layout

Each package follows `packages/sandbox/sandbox-docker` conventions: `adapter.ts`, `instance.ts`, `validate.ts`, `classify.ts`, `types.ts`, `index.ts` plus colocated `*.test.ts` per file.

### `@koi/sandbox-wasm` (~700 LOC src + tests)

```
src/
  index.ts             — public exports
  types.ts             — WasmExecutorConfig, internal types
  validate.ts          — validateWasmConfig (Result<T, E>)
  classify-error.ts    — error → SandboxErrorCode
  module-loader.ts     — sync loader: bytes → WebAssembly.Module
  async-module-loader.ts — async loader: URL/Response → Module
  wasm-executor.ts     — sync SandboxExecutor (no host imports)
  async-executor.ts    — async SandboxExecutor (host imports allowed: clock, RNG)
  *.test.ts            — colocated unit tests
```

- Uses native `WebAssembly` global (Bun built-in). Zero deps.
- **Two executors with distinct trust models:**
  - **`wasm-executor` (sync)** — TRUSTED CODE ONLY. Runs `WebAssembly.Instance.exports.<fn>(...)` on the host event loop. A hostile or buggy guest with a tight loop pins the host thread; `AbortSignal` cannot interrupt synchronous WASM. Documented limitation: `timeoutMs` is advisory for sync executor and is enforced only at boundaries (pre-call, post-call). Caller MUST treat sync executor as same trust boundary as the host.
  - **`async-executor` (untrusted-safe)** — runs the module inside a `Worker` (Bun worker thread). The worker is `terminate()`d when `AbortSignal` fires or `timeoutMs` elapses, providing real preemption for hostile code. This is the default for any code-injection or third-party brick scenario.
- `index.ts` exports both with explicit names (`createTrustedWasmExecutor`, `createWasmExecutor`); `createWasmExecutor` is the worker-backed default.
- **Memory enforcement is real, not advertised — direct binary parse, not `Module.imports()`:** `WebAssembly.Module.imports()` only reports imports, not the presence of an internal memory section, so it is insufficient on its own. The executor includes a small WASM binary scanner (`module-loader.ts::scanMemorySections`) that walks the module bytes once before compilation:
  - Verifies the magic bytes (`\0asm`) and version.
  - Iterates section headers (LEB128-decoded length-prefixed sections).
  - Inspects section ID `5` (Memory) and section ID `2` (Import).
  - **Rejects** any module where section 5 is non-empty (declares an internal memory) — `KoiError { code: "PERMISSION", reason: "module-defines-internal-memory" }`.
  - **Requires** at least one `(import "env" "memory" memory ...)` entry in section 2 — `KoiError { code: "PERMISSION", reason: "module-missing-memory-import" }` for memoryless modules. Memoryless modules are NOT silently accepted: every accepted module imports its memory from the host, so the host's `WebAssembly.Memory({ initial, maximum })` is the only memory the instance can address.
- **Why we don't accept memoryless modules:** if a module imports nothing, a follow-up edit could add an internal memory section and the same rejection logic would catch it. Forcing every accepted module to declare an explicit memory import keeps the check uniform and avoids a "no memory at all is fine" edge case that complicates the rule.
- The scanner is hostile-input-safe: bounded iteration, fails on malformed LEB128 with `PERMISSION`, never allocates beyond a small fixed cursor. This is enforced symmetrically in both the trusted-sync and untrusted-async executors and is covered by adversarial fixtures (modules with internal memory, modules with both internal+imported memory, malformed LEB128, oversized section length claims).
- **Imports allowlist:** by default `imports` config is empty (`{}`); the executor injects only the host-controlled memory. Any module import not satisfied by the allowlist (other than the memory) causes `WebAssembly.Module.imports` validation to surface a `LinkError` → mapped to `PERMISSION`.
- CPU cap = worker termination (async) / advisory only (sync — trusted code only). No instruction metering — explicitly out of scope.
- Code input: caller passes WASM bytes as `Uint8Array` only (precompiled `WebAssembly.Module` is rejected — see contract section above).
- `output`: serialized return value of the called export.
- Error mapping: trap → `CRASH`, OOM (memory.grow fails against the imported maximum) → `OOM`, worker terminated by deadline → `TIMEOUT`, module-defines-internal-memory or unknown import → `PERMISSION`.

### `@koi/sandbox-cloudflare` (~350 LOC src + tests)

```
src/
  index.ts
  types.ts             — CloudflareConfig, deploy/invoke shapes
  validate.ts          — validateCloudflareConfig (token, accountId, scriptName)
  classify.ts          — fetch error / status → KoiError
  client.ts            — minimal fetch wrapper for Cloudflare API
  instance.ts          — EdgeFunctionInstance over deployed worker URL
  adapter.ts           — createCloudflareAdapter → EdgeFunctionAdapter
  *.test.ts
  __tests__/integration.test.ts — env-gated live deploy
```

- Auth: `apiToken` + `accountId` from config. Token never logged.
- **Per-instance two-artifact naming:** every `create()` call deploys **two artifacts** for the two-worker isolation pattern:
  - **Worker A (gateway):** `${configPrefix}-gw-${randomUUID()}` (e.g., `koi-sandbox-gw-7f3a...`)
  - **Worker B (handler):** `${configPrefix}-hr-${sameUUID()}` (same UUID suffix as Worker A so the pair is identifiable from either name)
  Config supplies an optional `scriptPrefix` (default `koi-sandbox`); the random suffix is owned by the instance and shared by both artifacts. Two concurrent `create()` calls cannot collide on either artifact.
- **Worker B trust boundary differs by provider — Cloudflare structurally private; Vercel public-but-authenticated:**
  - **Cloudflare (structurally non-public):** Worker B is deployed with `workers_dev: false` and **no custom route or activation step is ever performed on it**. It has NO public URL and is unreachable from the open internet. The only path to Worker B is a Service Binding from Worker A (intra-account RPC; provider-enforced, no public listener). This IS a structural-privacy guarantee: even an orphaned, abandoned, or leaked Worker B is unreachable.
  - **Vercel (defense-in-depth: provider gate + per-pair asymmetric signature):** Vercel has no provider primitive equivalent to Cloudflare's `workers_dev: false` for deployment URLs. Worker B's deployment URL `https://${B-deploymentId}.vercel.app` IS reachable from the open internet at the moment Vercel materializes the deployment, but the adapter requires Vercel **deployment protection** on all preview URLs (verified at adapter construction; refusal otherwise — see the "VERCEL_PROTECTION_REQUIRED" gate below). Two layers gate access to Worker B:
    1. **Provider gate (Vercel deployment protection):** unauthenticated callers from the open internet are blocked by Vercel before they reach Worker B.
    2. **Application-layer Ed25519 signature (per-pair asymmetric):** even a caller that bypasses the provider gate must hold the per-pair private signing key to invoke Worker B successfully.

    Worker A satisfies the provider gate by sending Vercel's documented automation-bypass header `x-vercel-protection-bypass: ${KOI_VERCEL_BYPASS}` on every request. **`KOI_VERCEL_BYPASS` is treated as a transit-layer convenience credential, NOT a security-boundary secret.** Its purpose is solely to get Worker A's request past Vercel's provider gate so it can reach Worker B. **The actual trust boundary is per-pair Ed25519 signature verification.** A leaked bypass secret cannot, by itself, allow an attacker to forge a successful invocation: Worker B verifies Ed25519 on every request and rejects unsigned/invalid-signed traffic with 401. The bypass secret is provisioned to Worker A only, never to Worker B (Worker B does not verify the bypass — Vercel does, before routing).

    **The dedicated-Vercel-project requirement is therefore an operator provisioning convention, not a runtime invariant.** Treating it as a polled invariant created a 5-minute drift window in which a transient project-mixing event could (in theory) expand the bypass blast radius. With Ed25519 as the sole trust boundary, that drift window does not actually weaken security — a leaked bypass + unbroken Ed25519 = no compromise. The recommendation to operators (and the L2 doc) is still: provision a dedicated Vercel project per fleet, attest `koiOnlyProjectAttested: true` at construction. The adapter records the attestation and emits a one-shot warning if non-koi deployments are observed at construction time, but **does NOT continuously poll** and does NOT poison live instances on mid-run drift. Removing the poll closes the polling-cadence gap by removing the polled invariant entirely; the actual security boundary (Ed25519) does not depend on project dedication being maintained.
    - Adapter config still requires `config.koiOnlyProjectAttested: true` — the operator's acknowledgment of the recommended provisioning convention. Required because operators who don't think about this often fail to set up dedicated projects, and the resulting confused error surface from non-koi deployments interfering with sweeper queries is unhelpful to debug. Construction-time scan is best-effort logging: any non-koi deployment found in the project emits a `VERCEL_PROJECT_NOT_DEDICATED_WARNING` log line but does NOT reject construction.
    - **The L2 doc reframes the requirement: "Provision a dedicated Vercel project per fleet. The koi-Vercel trust boundary is per-pair Ed25519 signature verification, NOT project-scoped bypass-secret isolation. A leaked `KOI_VERCEL_BYPASS` does not compromise koi pairs as long as the per-pair Ed25519 signing key is uncompromised. Project dedication is recommended for operational hygiene (cleanup queries, metric noise) but is not a security boundary."**
    - **Adversarial test (mandatory):** `__tests__/vercel-bypass-leak-does-not-compromise.test.ts` (a) constructs adapter, creates instance; (b) externally attempts to invoke Worker B's URL with the leaked `KOI_VERCEL_BYPASS` header but no Ed25519 signature; (c) asserts the request is rejected by Worker B with 401 `INVALID_SIGNATURE` despite passing Vercel's gate. This proves the trust boundary is Ed25519, not the bypass secret.

    **Bypass-secret rotation is operator-coordinated, not auto-detected.** Vercel's documented Protection Bypass for Automation secret is project-scoped and injected into deployments at build time. The Vercel API does NOT expose the live secret value to API callers, so the adapter cannot independently observe rotation against a provider source of truth — any "drift detection" based purely on `config.bypassSecret` would compare operator-supplied values against operator-supplied values and silently miss rotations on hosts the operator forgot to update. The earlier draft's auto-poison-on-drift mechanism is therefore removed:
    - Rotation is treated as an **operator-coordinated lifecycle event**, not an automatic poison path. The L2 doc documents the procedure: "Rotating the project Protection Bypass for Automation secret invalidates all live Vercel pairs. The operator MUST: (1) rotate the secret in the Vercel project, (2) update adapter config on every host with the new value, (3) call `destroy()` on all live instances and recreate them. The adapter does NOT detect rotation automatically."
    - The runtime-observable signal of an unannounced rotation IS request-level failure: Worker A's calls to Worker B start being blocked by Vercel's gate (HTTP from Vercel before reaching Worker B). The adapter logs these as `VERCEL_BYPASS_REJECTED` and surfaces them via `invoke()`'s normal error path, which lets operators detect and remediate. This is observable, not silent — but recovery requires the recreate workflow above, not an adapter-internal poison.
    - The legacy alternative — making A→B traffic NOT depend on the project bypass — was rejected because Vercel does not expose any documented authenticated-but-non-public-call channel between deployments other than the bypass mechanism.

    The trust boundary is **application-layer Ed25519 signature verification** plus **Vercel deployment protection**, not symmetric HMAC and not provider-enforced privacy:
    - The host generates a fresh per-pair Ed25519 keypair at create time. The **private signing key** is provisioned to Worker A as `KOI_PAIR_SIGNING_KEY` (Worker A only, never Worker B). The **public verification key** is provisioned to Worker B as `KOI_PAIR_VERIFY_KEY` (Worker B only, sufficient to verify signatures, useless for forging them).
    - Worker A signs every outbound request with `Ed25519(KOI_PAIR_SIGNING_KEY, canonical)` placed in `X-Koi-Pair-Sig`, where `canonical = "${method}\n${path}\n${operationId}\n${requestId}\n${nonce}\n${timestampMs}\n${sha256(body)}"`. The signed material includes:
      - HTTP method and path (so a captured signature for `/invoke` cannot be replayed against `/cancel`).
      - `operationId`, `requestId`, fresh per-request `nonce` (16 random bytes, base64url).
      - `timestampMs` (rejected if older than 60s OR more than 5s in the future — protects against clock skew exploits).
      - SHA-256 of the request body (so an attacker who captures a signature cannot swap the payload).
    - Worker B verifies the signature using `KOI_PAIR_VERIFY_KEY` and additionally enforces **pair-scoped nonce uniqueness** within the 60-second replay window: each pair maintains a Vercel-KV-backed `nonce-seen:${pair_uuid}:${nonce}` key with a 90-second TTL set via `SET NX EX 90` before the request is accepted. If `SET NX` fails (nonce already used), Worker B rejects with 401 even if the signature verifies. With both checks, an attacker who captures a valid signed request cannot replay it within the window (nonce already burned) AND cannot replay it after the window (timestamp rejected).
    - **Worker B's KV credential is namespace-scoped, NOT a full dedupe credential.** Worker B receives `KOI_PAIR_NONCE_KV_TOKEN`, an Upstash/Vercel-KV REST token whose ACL permits ONLY `SET NX EX` and `GET` on the prefix `nonce-seen:${pair_uuid}:*` — and nothing else. Worker B's token CANNOT read/write `${ownerId}:claim:*`, `${ownerId}:result:*`, `${ownerId}:failed:*`, or any other pair's `nonce-seen:*` keys. A malicious handler that reads `KOI_PAIR_NONCE_KV_TOKEN` from its own env can mutate its own pair's nonce-seen keys (e.g., burn a nonce early — at most causes the next legitimate Worker A request to fail-and-retry, no privilege escalation) but CANNOT tamper with dedupe state. The trust-boundary statement "Worker B has no dedupe credentials" is preserved: nonce-seen keys are NOT dedupe state, they are pair-private replay-protection state. The L2 doc states this explicitly.
    - Worker A's KV token (`KOI_DEDUPE_KV_TOKEN`) is broader (full claim/result/failed access) and is provisioned to Worker A only.
    - 401 with no body on signature mismatch, body-hash mismatch, expired timestamp, or replayed nonce. Constant-time comparison everywhere.
    - **Asymmetric is the critical choice:** even a fully malicious or compromised handler running in Worker B can read its own env (`KOI_PAIR_VERIFY_KEY`) but CANNOT use it to forge a request — the verify key proves a signature came from the holder of the signing key, but cannot itself produce signatures. Symmetric HMAC was rejected because Worker B's env is readable by operator code; an exfiltrated HMAC secret would allow direct invocation of Worker B bypassing Worker A entirely. The earlier `VERCEL_INTER_DEPLOYMENT_SECRET` (HMAC) design is replaced wholesale by this Ed25519 model.
    - The legacy `x-vercel-signature` was removed because it is for Vercel-originated webhooks, not deployment-to-deployment calls.
  - **Implications of the weaker Vercel boundary:**
    - A leaked/orphaned Worker B remains URL-reachable until the adapter or sweeper deletes it. Any **Ed25519 verification bug** (e.g., constant-time-comparison error, signature-malleability handling, replay-window misconfiguration) becomes externally exploitable for the lifetime of the orphan. The pair-isolation adversarial test (`__tests__/vercel-pair-isolation.test.ts`) is mandatory CI on every PR that touches Vercel auth.
    - The cleanup guarantees in the orphan/leak-window section are correspondingly weaker for Vercel than for CF. Cleanup latency directly affects external attack surface on Vercel; on Cloudflare it does not.
    - **v1's class-A workload restriction** (handlers are side-effect-free) means a successful unauthorized invocation can do nothing externally observable — there are no side effects to trigger. This is a stronger property than the deferred class-B's `assertIdempotent: true` attestation would have provided.
    - `docs/L2/sandbox-vercel.md` MUST state explicitly: "Worker B is reachable on a public Vercel deployment URL gated by Vercel deployment protection AND verified via per-pair Ed25519 signature. Provider-enforced privacy is not available on Vercel; the combined deployment-protection + Ed25519 implementation IS the trust boundary. NO symmetric secret in Worker B's env participates in authentication."
  - **Worker B is never given a custom domain or activation step on either provider.** That part is unchanged.
  Worker B's deploy step is steps 1+2 ONLY (deploy + secrets). The activation step (3) flips reachability for Worker A only. A future PR could expose Worker B for direct invocation by adding its own auth, but this PR forbids that path.
- **Both artifacts tracked end-to-end:** the create state machine, orphan ledger, sweeper, and `destroy()` track the pair as a unit. Schema additions:
  - SQLite ledger persists **one row per artifact** (Worker A and Worker B each get their own row, distinct `artifact_kind`, distinct deterministic recovery keys) sharing a `pair_uuid` so reconciliation can correlate halves but delete each artifact's row as its DELETE confirms. The full schema is in the "Durable orphan tracking" section below; this is the summary.
  - Provider-side ownership tags include the shared `koi-pair-uuid` so the sweep can identify a half-leaked pair from either side and clean both.
  - `destroy()` issues two DELETEs (Worker A then Worker B for CF, or both deployments for Vercel) atomically wrapped in a single mutex. `DestroyOutcome.providerArtifact` is now `string[]` reporting both names; if either DELETE fails the outcome includes the full pair so the orphan ledger captures both.
  - Create-failure cleanup follows the same logic: every failure step issues DELETEs against any artifact already deployed. **Worker B is deployed first** (steps 1–3) and is therefore the artifact that may exist on early failures; Worker A is deployed second (steps 4–7) and only exists on later failures. The full step-by-step cleanup obligations are tabulated in the next section.
- **Per-attempt client-side identity (Vercel-recovery key):** Vercel assigns `deploymentId` server-side, so a create timeout before the response returns can leave the host without an identity to use for cleanup. To make every create attempt independently recoverable, the adapter generates a per-attempt UUID `attemptId = randomUUID()` BEFORE issuing the deploy POST and writes it to deployment metadata: `meta = { ..., "koi-attempt-id": attemptId }`. On any create failure where the response did not return (timeout, network error, or unparseable response), the adapter calls `GET /v6/deployments?meta-koi-attempt-id=${attemptId}` to discover the `deploymentId` of the artifact (if it materialized) and uses it for the cleanup DELETE. The `attemptId` itself is recorded in the orphan ledger so a host crash before the `GET` resolves still leaves a deterministic recovery key — the next adapter to read the ledger can complete the lookup. Cloudflare uses the deterministic `scriptName` directly; Vercel uses the `attemptId` lookup as its equivalent.

#### Create-failure state machine (orphan-safe)

Remote create involves a **paired-artifact state machine** (Worker B handler-runner deployed first, Worker A gateway second), chosen so that **a partially-created artifact is never reachable with secrets attached** AND so Worker A cannot be activated until Worker B is verified deployable:

| Step | Artifact | Action | On failure → cleanup |
|------|----------|--------|----------------------|
| 1 | Worker B | `PUT /workers/scripts/${B-name}` with `workers_dev: false`. **Bytes deployed in step 1 are the koi-owned bootstrap shim AND the operator handler module bundled together as static ES modules — NOT a base64 blob, NOT eval, NOT dynamic-import-of-non-static-string.** The earlier draft used `eval()`/dynamic-import-of-blob, which contradicted the workload-class-A AST scan that rejects exactly those primitives in operator code. The corrected design: the operator's bundled `handler.js` ships alongside the shim's `bootstrap.js` in the same Worker script bundle, and the shim references the operator module via a deferred-loader using a STATIC string specifier `await import("./handler.js")`. Static-string `await import()` is bundle-resolvable at build time, exercises no string-eval primitive, and is what bundlers like esbuild/wrangler emit natively. **Two-tier AST policy (explicit):** the AST scan that rejects `dynamic import(${nonStaticString})` and `new Function`/`eval` applies to the **operator handler module ONLY**. The koi-owned bootstrap shim is exempt because (a) its source is fixed, koi-authored, version-pinned, and reviewed by koi maintainers, (b) its deployed bytes are content-hash-locked against `bootstrap-shim.lock.json` shipped in the adapter package, and (c) its ONE deferred-loader call uses a static specifier the scan would accept anyway. **Hard rule: the operator handler module MUST NOT execute side effects at module top level** — its top level is restricted to `import` statements and `export` declarations only; the actual handler logic lives inside an exported `handle(payload)` function called by the shim only after Ed25519 signature validation AND `env.KOI_HANDLER_ARMED === "true"`. Because ES module evaluation order means a static top-level import would run the operator's top-level code immediately, the shim does NOT statically import the operator at top level — it imports it from inside its `fetch` event handler via the deferred-loader pattern, AFTER (a) installing the class-A throwing-stub fences via `Object.defineProperty(globalThis, "fetch"|"XMLHttpRequest"|"WebSocket", ...)`, (b) verifying the request's Ed25519 signature, (c) checking `KOI_HANDLER_ARMED === "true"`. **CI gates (all mandatory):** `__tests__/bootstrap-shim-no-top-level-handler-eval.test.ts` parses the bundle AST and asserts (a) the bootstrap shim's reference to `./handler.js` is via deferred `await import("./handler.js")` with a static string literal — NOT a static top-level `import` — and the call site is INSIDE the fetch handler, AFTER the fence-install + sig-verify + armed-check sequence; (b) no top-level `eval`/`new Function` calls in any module of the bundle; (c) the operator handler module's top level contains only `import` declarations and `export` declarations — no expression statements, no IIFEs, no top-level await of side-effectful expressions. `__tests__/bootstrap-shim-content-hash.test.ts` asserts the deployed shim bytes hash to the value in the adapter package's `bootstrap-shim.lock.json`, so drift in the koi-owned shim is caught at deploy time. Until armed, every request returns 401 `KOI_PAIR_NOT_INITIALIZED`. | Step 1 failure: **always indeterminate** — once the PUT request has been issued, the artifact MAY have materialized even on timeout/network error. Adapter ALWAYS issues `DELETE /workers/scripts/${B-name}` and ALWAYS persists a Worker B orphan-ledger row before returning. |
| 2 | Worker B | `PUT /workers/scripts/${B-name}/secrets` for `KOI_PAIR_VERIFY_KEY` (the **public** half of the per-pair Ed25519 keypair generated host-side at create time, specific to this A/B pair only, never reused across pairs; CF: skip — Service Bindings need no signature) AND (Vercel only) `KOI_PAIR_NONCE_KV_TOKEN` (the namespace-scoped Vercel-KV REST token whose ACL permits ONLY `SET NX EX` and `GET` on the prefix `nonce-seen:${pair_uuid}:*`; required so Worker B can enforce per-pair nonce uniqueness for replay protection — see the Vercel trust-boundary section). Worker B holds the verification key, the nonce-KV token (Vercel only), and nothing else. The bootstrap shim is now able to verify request signatures and burn nonces but still rejects every request because `KOI_HANDLER_ARMED` is unset. | Step 2 failure: DELETE Worker B. |
| 3 | Worker B | `PUT /workers/scripts/${B-name}/secrets` for `KOI_HANDLER_ARMED: "true"` ONLY. **No operator env upload** — class A handlers MUST NOT carry operator secrets (the validation table rejects non-empty `env`). The bootstrap shim's per-request `await import()` of the operator handler now succeeds for requests that pass Ed25519 verification. Worker B contains zero operator credentials throughout its lifetime. | Step 3 failure: DELETE Worker B. No secret rotation needed because no operator secrets were ever written. |
| 4 | Worker A | `PUT /workers/scripts/${A-name}` with `workers_dev: false` AND a binding declaration that points to Worker B (CF: `services` block in script settings; Vercel: no binding-layer config — A invokes B by deployment URL plus per-pair Ed25519 signature). | Step 4 failure: **always indeterminate for Worker A** (PUT may have materialized A even on timeout/network error). DELETE Worker A first if step 4 had begun, then DELETE Worker B. Persist orphan-ledger rows for BOTH artifacts on indeterminate outcomes. The single-source-of-truth artifact table below is the authoritative cleanup spec. |
| 5 | Worker A | `PUT /workers/scripts/${A-name}/secrets` for `KOI_INSTANCE_TOKEN`, `KOI_OWNER_ID`, dedupe credentials (`KOI_DEDUPE_KV_URL`, `KOI_DEDUPE_KV_TOKEN`), AND (Vercel only) `KOI_PAIR_SIGNING_KEY` (the **private** half of the per-pair Ed25519 keypair — corresponding public key provisioned to Worker B in step 2; signing key is bound to this pair only and never leaves Worker A) AND (Vercel only) `KOI_VERCEL_BYPASS` (the project-scoped Vercel automation-bypass header value Worker A sends as `x-vercel-protection-bypass` on every outbound request to Worker B; transit-layer convenience, NOT the security boundary — see the Vercel trust-boundary section). Cloudflare skips Vercel-only secrets because Service Bindings are an account-internal RPC channel that needs no signature and no provider-gate bypass. | Step 5 failure: DELETE Worker A then Worker B (both leaked; CF Worker B private, Vercel Worker B public-but-no-public-key-cannot-be-forged-against). |
| 6 | Worker A | **Provider-specific readiness probe.** The two providers expose different pre-activation primitives, so the readiness step is provider-specific.<br>**Cloudflare:** Worker A is NOT externally reachable before subdomain enable, and CF does not provide a control-plane "execute unactivated worker" RPC. Therefore CF readiness is a **two-phase activate-then-probe** sequence within step 6: (a) `PATCH /workers/scripts/${A-name}/subdomain` to set `enabled: true` — Worker A is now publicly reachable at `${A-name}.${subdomain}.workers.dev` BUT its bootstrap is in **GUARDED MODE** (a deploy-time env flag `KOI_FULLY_ACTIVATED !== "true"` causes Worker A to reject ALL routes except `/__koi_ready` AND require Bearer `KOI_INSTANCE_TOKEN` on that route); (b) host calls `https://${A-name}.${subdomain}.workers.dev/__koi_ready` with Bearer; Worker A issues an internal Service-Binding RPC to Worker B (no signing — bindings are account-internal); Worker B verifies `KOI_HANDLER_ARMED === "true"` and returns 200; Worker A returns 200 to the host iff the binding RPC succeeded. The exposure during step 6's guarded mode is bounded: an external attacker without `KOI_INSTANCE_TOKEN` is rejected by Worker A's bootstrap on every route; with the token, only `/__koi_ready` is reachable and it has no side effects beyond the read-only B-binding probe. **Step 7 then sets `KOI_FULLY_ACTIVATED=true` to lift guarded mode.**<br>**Vercel:** Worker B's deployment URL is internet-reachable from step 1 onward, gated by Vercel deployment protection + Ed25519. Vercel readiness is the host→A→B signed-path probe described originally: host calls Worker A's `/__koi_ready` with Bearer `KOI_INSTANCE_TOKEN` + `x-vercel-protection-bypass: ${KOI_VERCEL_BYPASS}`. Worker A signs a synthetic readiness body with `KOI_PAIR_SIGNING_KEY` and POSTs to Worker B's URL. Worker B verifies signature, burns nonce, returns 200. Worker A returns 200 iff B did. The host never holds the signing key. | Step 6 failure: DELETE Worker A then Worker B. CF: also rolls back subdomain to `enabled: false`. Without a passing readiness probe the instance does NOT enter `ready`. |
| 7 | Worker A | **Lift guarded mode (CF) / no-op (Vercel).** **Cloudflare:** `PUT /workers/scripts/${A-name}/secrets` for `KOI_FULLY_ACTIVATED: "true"`. After this PUT, Worker A's bootstrap accepts the full route set (`/invoke`, `/cancel`, etc.) — the guarded-mode flag is the activation switch. **Vercel:** no separate activation. Each `EdgeFunctionInstance` keeps the immutable per-deployment URL. **Project-level promote-to-production is explicitly forbidden** — the adapter NEVER calls `/v13/deployments/${id}/promote`. | Step 7 failure: DELETE Worker A then Worker B. CF: A's subdomain is enabled but Worker A still rejects everything except `/__koi_ready` (because `KOI_FULLY_ACTIVATED` was never set true), so cleanup races leave no exploitable surface beyond the harmless probe route. Vercel: A's URL was reachable since step 4, gated by `KOI_INSTANCE_TOKEN` + `KOI_VERCEL_BYPASS`; A→B is gated by `KOI_PAIR_SIGNING_KEY` which never leaves A. |
| 8 | — | Instance enters `ready`. Lease renewal heartbeat starts; worker-alive heartbeat begins on Worker A. | — |

**Reachability after step 1 differs by provider — the generic "no attacker can invoke either one" rule applies ONLY to Cloudflare.** Failure at any step before step 7 on **Cloudflare** means Worker A is not externally invokable (still `workers_dev: false`) and Worker B is never externally invokable (always `workers_dev: false`); even if cleanup races leave CF artifacts behind, no attacker can reach them. **Vercel** is materially different: Worker B's deployment URL is internet-reachable from step 1 onward and Worker A's URL is reachable from step 4 onward; reachability is gated by Vercel deployment protection + per-pair Ed25519, not by provider-side privacy. See the per-provider reachability subsection below for the authoritative incident-response model. **Custom domain activation is explicitly out of scope** for the same reasons described in earlier rounds (host-side endpoint validation accepts only `*.workers.dev` and `*.vercel.app`).

The state machine is `allocating → b-deploying-private → b-secrets-uploading → b-binding-secrets-uploading → a-deploying-private → a-secrets-uploading → a-binding-probe → activating → ready`, with cleanup edges from every state to the appropriate combination of `DELETE Worker A` and/or `DELETE Worker B`.

Per-step artifact-existence-and-cleanup table (single source of truth — derives from the deploy order Worker B first, Worker A second):

| Failed step | Worker B exists? | Worker A exists? | Cleanup obligation |
|-------------|-------------------|--------------------|---------------------|
| 1 (B-deploying) | maybe (in-flight) | no | DELETE Worker B if step 1 had begun. Indeterminate result possible. |
| 2 (B-secrets) | yes | no | DELETE Worker B. |
| 3 (B-pair-secret) | yes | no | DELETE Worker B. |
| 4 (A-deploying) | yes | maybe (in-flight) | DELETE Worker A if step 4 had begun, then DELETE Worker B. |
| 5 (A-secrets) | yes | yes | DELETE Worker A, then DELETE Worker B. |
| 6 (binding-probe) | yes | yes | DELETE Worker A, then DELETE Worker B. |
| 7 (activating) | yes | yes (briefly reachable) | DELETE Worker A first (revoke reachability), then DELETE Worker B. |

Reachability of leaked artifacts during create-failure cleanup **differs by provider** because Cloudflare and Vercel have different provider primitives for non-public deployments:

- **Cloudflare (structural privacy, all steps ≤ 6):** Worker A is never externally invokable until step 7 (`workers_dev: false` until activation). Worker B is **never** externally invokable at any step (always `workers_dev: false`, no route, no activation). Step 7 is the only window where Worker A is briefly reachable, gated by `KOI_INSTANCE_TOKEN`. This IS a structural provider-level guarantee.

- **Vercel (public-but-authenticated from the moment of materialization):** Worker B's deployment URL becomes URL-reachable from the open internet as soon as Vercel materializes the deployment (step 1 onward). Vercel deployment protection (provider gate) AND per-pair Ed25519 signature (application layer) both apply from the moment Worker B materializes. **A leaked Vercel Worker B is invokable on its public URL by anyone who learns the URL** — they will be rejected by Vercel's protection gate, and even if they bypass it (leaked operator automation secret), they will be rejected by Ed25519 verification because they don't hold the per-pair signing key. Cleanup urgency is correspondingly higher than for Cloudflare: every minute a leaked Vercel Worker B exists is a minute of public exposure (auth-gated, but auth-gated is still public). Worker A is similarly URL-reachable from step 4 onward; pre-step-7 the bearer token + protection bypass + signing key are required to invoke it.

Net: Cloudflare leaks behind a structural-privacy gate are **inert**; Vercel leaks behind authentication are **public-but-authenticated** and require Ed25519 + bypass + protection-gate failures (multi-layer defense) to be exploited. The cleanup guarantees and adversarial tests above (paired DELETE, orphan ledger persistence, reconciler) apply to both, but operators on Vercel must treat any `CREATE_FAILED_INDETERMINATE` outcome as a higher-urgency cleanup incident than the equivalent CF outcome.

States:

```
allocating → deploying-unreachable → secrets-uploading → activating → ready
        \           \                       \                \
         \           \                       \                +--> create failure → cleanup (was reachable briefly)
          \           \                       +----------------> create failure → cleanup (unreachable, secrets attached but inert)
           \           +-----------------------------------------> create failure → cleanup (unreachable, no secrets)
            +---------------------------------------------------> no remote artifact yet
```

The `unreachable` qualifier on intermediate states is **CLOUDFLARE-ONLY**. On Cloudflare, until the `activating` step completes, `https://{name}.{subdomain}.workers.dev` returns a Cloudflare 522/523 (no route configured), regardless of what the worker code does. **Vercel does NOT have an "unreachable intermediate state":** every Vercel deployment is internet-addressable from materialization, gated solely by deployment protection. The state-machine diagram above's `deploying-unreachable` and `secrets-uploading` states are accurate for Cloudflare but represent `deploying-public-but-protection-gated` and `secrets-uploading-public-but-protection-gated` on Vercel — incident assumptions for the two providers are NOT interchangeable.

**Two-worker authentication (Worker A holds the token; Worker B never sees it):**

URL secrecy and provider-side protection are not enough on their own. Once Worker A (`koi-dedupe-gateway`) is activated, anyone who learns the URL can hit it. To close this gap, the adapter generates a per-instance authentication token at `create()` time and Worker A enforces it on every inbound request:

- During `create()`, the host generates `instanceToken = randomBytes(32).toString("base64url")` (256 bits). This token is uploaded as a **Worker A secret** only — `KOI_INSTANCE_TOKEN` is bound to Worker A, never to Worker B. Worker B's deploy step does not include this secret.
- Worker A's request handler reads `KOI_INSTANCE_TOKEN` from its own secrets and rejects any incoming request whose `Authorization: Bearer <token>` header does not match exactly. Constant-time comparison; 401 with no body on mismatch. Applies to `/invoke`, `/cancel`, every external endpoint.
- Worker A → Worker B communication does NOT use `KOI_INSTANCE_TOKEN`. Cloudflare uses Service Bindings (private intra-account RPC, no auth required). Vercel uses **per-pair Ed25519 asymmetric signatures**: Worker A signs every request with `KOI_PAIR_SIGNING_KEY` (private; Worker A only); Worker B verifies with `KOI_PAIR_VERIFY_KEY` (public; Worker B only). The signing key is generated host-side at create time as a fresh per-pair Ed25519 keypair, provisioned to Worker A in step 5 of the create state machine and (verify half only) to Worker B in step 3, and destroyed when the pair is destroyed. A compromised handler running in Worker B can read its own env (`KOI_PAIR_VERIFY_KEY`) but cannot use the verify key to forge requests — Ed25519 verification keys are useless for signing. A different pair's Worker A cannot impersonate this pair's Worker A because it holds a different signing key. Symmetric HMAC was rejected wholesale: Worker B's env is operator-readable, and a leaked HMAC secret from there would let any external attacker invoke Worker B directly. The bearer `KOI_INSTANCE_TOKEN` never enters Worker B's environment; the signing key never leaves Worker A.
  - **Adversarial tests (mandatory):**
    - `__tests__/vercel-pair-isolation.test.ts` deploys two A/B pairs in the same fleet/project and asserts that pair-1's Worker A cannot authenticate to pair-2's Worker B (Ed25519 verification rejects, 401).
    - `__tests__/vercel-handler-cannot-forge.test.ts` exercises a Worker B handler that reads `KOI_PAIR_VERIFY_KEY` from its own env and attempts to use it to sign a synthetic request to itself; asserts the synthetic request is rejected with 401 (verify key cannot produce signatures).
  - Tests must pass for every PR that touches Vercel auth code.
- **Vercel Worker B credential set (single authoritative list).** Worker B's deployment receives EXACTLY: `KOI_PAIR_VERIFY_KEY` (Ed25519 public key — useless for forging signatures), `KOI_HANDLER_ARMED` (boolean armed flag), AND `KOI_PAIR_NONCE_KV_TOKEN` (a namespace-scoped Vercel-KV REST token whose ACL permits ONLY `SET NX EX` and `GET` on the prefix `nonce-seen:${pair_uuid}:*`). **Cloudflare Worker B receives only `KOI_PAIR_VERIFY_KEY` and `KOI_HANDLER_ARMED`** — no nonce-KV token because CF Service Bindings do not require Ed25519 nonce protection. **No operator-supplied `env` secrets on either provider** — class A handlers are pure compute and the validation table rejects non-empty `env`. **Worker B's blast-radius statement is qualified, not absolute:** Worker B carries zero OPERATOR credentials and zero general-purpose gateway/dedupe credentials (no `KOI_INSTANCE_TOKEN`, no `KOI_DEDUPE_KV_TOKEN`, no DO bindings). What it DOES carry on Vercel is the namespace-scoped nonce-KV token. The blast radius of `KOI_PAIR_NONCE_KV_TOKEN` exfiltration is bounded: an attacker who reads it can `SET NX EX` and `GET` on `nonce-seen:${pair_uuid}:*` only — they can burn a nonce early (causes the next legitimate Worker A request for THIS pair to fail-and-retry, no privilege escalation, no cross-pair impact), or read which nonces have been used (a nonce hash, not request content). The token CANNOT read/write `${ownerId}:claim:*`, `${ownerId}:result:*`, `${ownerId}:failed:*`, `${ownerId}:ledger:*`, or any other pair's `nonce-seen:*` keys. The earlier draft's "Worker B carries zero credentials" claim is reframed as the precise contract: "Worker B carries zero credentials beyond a per-pair, namespace-scoped, append-only nonce-burn token whose worst-case abuse is local DoS of its own pair's nonce window."
- The host-side `EdgeFunctionInstance` retains `instanceToken` in private state and sends `Authorization: Bearer ${instanceToken}` to Worker A only. Token never logged or exposed in public API surface.
- `destroy()` deletes both Worker A and Worker B (lifecycle below); both secrets are removed atomically with their respective deployments.
- This is mandatory. Worker A's handler refuses to start if `KOI_INSTANCE_TOKEN` or `KOI_PAIR_SIGNING_KEY` is unset; Vercel Worker B's handler refuses to start if `KOI_PAIR_VERIFY_KEY` is unset; CF Worker B's handler refuses to start if the Service Binding sentinel is unset. Defense-in-depth against misconfigured deploys.

For Vercel, the analogous gate (for pre-activation reachability) requires **adapter-enforced deployment protection**, not an external account default:

- The adapter's `createVercelAdapter(config)` requires `config.projectId` and verifies via `GET /v9/projects/{projectId}` at construction time that the project has `ssoProtection.deploymentType` (or `passwordProtection.deploymentType`) set to `"all"` or `"prod_deployment_urls_and_all_previews"`. If protection is disabled or scoped narrower, `createVercelAdapter` returns `KoiError { code: "VERCEL_PROTECTION_REQUIRED", reason: "preview-protection-not-enforced" }` and refuses to construct.
- **Uncached re-check inside every `create()`:** project protection settings can drift after adapter construction (operator changes them on the dashboard). Each `create()` therefore re-issues the same `GET /v9/projects/{projectId}` check IMMEDIATELY before any deploy mutation, with **no caching of allow results**. Allow decisions are evaluated against fresh provider state on every create. The optional cache stores ONLY negative/terminal failures (e.g., `VERCEL_PROTECTION_REQUIRED`) for 30 seconds to short-circuit retries against a known-bad project; a positive `protection-enforced` result is never cached and never reused. This bounds API rate on the failure path while preserving the safety property on the allow path. If the live check shows protection has been disabled or scoped narrower, `create()` returns `VERCEL_PROTECTION_REQUIRED` and never deploys.
- **Continuous post-`ready` poll fails closed on first confirmed downgrade (NORMATIVE — required, not optional).** Construction-time + per-`create()` checks alone leave a gap: an operator who disables protection on the dashboard AFTER an instance reaches `ready` would leave the public Worker B URL up under a weaker trust boundary. To close the gap, the adapter runs a **30-second background poll** for the lifetime of every adapter process: `GET /v9/projects/{projectId}` and verify the protection setting still satisfies the construction-time invariant.
  - **First confirmed downgrade observation poisons every live instance immediately** with `KoiError { code: "VERCEL_PROTECTION_DOWNGRADED" }`; only `destroy()` is permitted thereafter. "Confirmed" = a single `200 OK` response from the Vercel projects API showing protection disabled or scoped narrower than the construction-time invariant. **No multi-check threshold.** The earlier draft's 5-consecutive-check / ~5-minute grace window is REMOVED — it left a documented multi-minute exposure window for the public-but-authenticated Worker B URL during which any latent bug in Ed25519 verification became internet-reachable. Fail-closed-on-first-observation is the right posture for a security-boundary signal.
  - **API errors are NOT treated as a downgrade signal.** Network errors, 5xx, rate limits, and timeouts on the `GET /v9/projects/{projectId}` poll are noisy telemetry and are tolerated up to **3 consecutive failures (~90s)** before transitioning to `VERCEL_PROTECTION_POLL_UNAVAILABLE` (a separate, less-fatal poison code that still stops new invokes but allows operator triage). Only an authoritative `200 OK` response with downgraded protection triggers immediate `VERCEL_PROTECTION_DOWNGRADED` poison. This separation prevents transient API blips from triggering a fleet-wide poison while still failing closed on a real downgrade.
  - **Stop new invokes on first observation, even before the poison propagates.** When the polling loop observes a confirmed downgrade, it sets a process-local atomic flag that every in-flight `invoke()` checks before forwarding to Worker A. Once the flag is set, all new `invoke()` calls reject synchronously with `VERCEL_PROTECTION_DOWNGRADED` even before the per-instance POISON state has been written. This closes the sub-second window between detection and propagation.
  - **Adversarial test (mandatory):** `__tests__/vercel-protection-downgrade-after-ready.test.ts` (a) constructs adapter and creates an instance, asserts `ready`; (b) externally disables project protection; (c) waits at most 30 seconds (one poll cycle); (d) attempts `invoke()` and asserts it rejects with `VERCEL_PROTECTION_DOWNGRADED` on the FIRST attempt after detection; (e) re-enables protection and confirms reconstruction succeeds. The structural reachability invariant is therefore guarded at THREE points: adapter construction, every `create()`, AND continuously thereafter with first-observation fail-closed semantics.
- Each deployment is created with `target: "preview"` and **stays on `target: "preview"` for its entire lifetime**. The adapter NEVER promotes a deployment to production — see the Activation row in the create-state table. Vercel deployment protection ("All deployments" or equivalent) covers preview deployments, so the protection gate applies to the immutable per-deployment URL the adapter uses. The earlier draft's "activation flips `target: \"production\"`" rule is REMOVED — it would have made activation a project-scoped routing mutation and reintroduced the cross-instance endpoint-theft hazard the create-state table forbids. Activation is purely the host-side bearer-token + Ed25519 + protection-bypass check; no `target` mutation occurs. **Custom-domain attachment is explicitly out of scope for this PR** (matching the Cloudflare custom-route exclusion above): trusting an arbitrary hostname during activation would force the adapter to send `Authorization: Bearer ${instanceToken}` payloads to a non-Vercel-owned endpoint, which the spec's threat model forbids without an ownership-verification protocol that does not exist yet. The host-side endpoint validation only accepts `https://${deploymentId}-*.vercel.app` and `https://${deploymentId}.vercel.app` URLs; anything else is rejected with `KoiError { code: "ENDPOINT_NOT_TRUSTED" }`.
- Pre-activation, the preview URL is reachable only with a valid Vercel SSO/password token bound to that project. The koi adapter never publishes that URL externally; even if leaked, the protection gate stops anonymous invocation.
- The `vercel-protection-required` smoke scenario is design-only for this release; it MUST NOT be wired as a required step in `provider-smoke.yml` because Vercel is deferred. When PR 5 lands, the scenario is added to `provider-smoke.yml` as a required step (and `provider-smoke.yml` itself becomes a Vercel merge gate at that point).

This makes Vercel's safety story adapter-enforced, not account-default-dependent.

Rules:

- **Bounded create timeout:** `createTimeoutMs` (default 30_000) wraps the entire create flow. On timeout, transition to `create failure`.
- **Pair-aware best-effort delete:** the create state machine deploys Worker B first (step 1) and Worker A second (step 4). On any create failure, the adapter unconditionally fires DELETE against **every artifact whose deploy step has been issued so far**, in reverse-deploy order (Worker A first if it was deployed, then Worker B). Cloudflare: `DELETE /workers/scripts/${A-name}` then `DELETE /workers/scripts/${B-name}`. Vercel: `DELETE /v13/deployments/${A-deploymentId}` then `DELETE /v13/deployments/${B-deploymentId}`. Each DELETE is fire-and-forget with its own short timeout (`cleanupTimeoutMs`, default 5_000) and is issued independently — failure of one does not skip the other. If only one of the pair was deployed before the failure (typical at steps 1–3), only that one is targeted; orphan-ledger entries always reflect the actual deployed set.
- **Cleanup confirmation (control-plane race aware), evaluated per artifact in the pair:**
  - The adapter tracks `deployStartedAt` for each artifact in the pair (`B-deployStartedAt`, `A-deployStartedAt`). Each artifact's DELETE result is interpreted independently against its own deploy state:
    - **Artifact's deploy fully completed before failure**: cleanup `200` / `204` = `cleanedUp: true` for that artifact. `404` is also accepted because the artifact existed and is now gone.
    - **Artifact's deploy did NOT complete or is in flight when failure was detected**: a `404` from cleanup is **NOT** proof of deletion for that artifact — the deploy can still materialize after the control-plane returned `404`. The artifact's identity (Cloudflare scriptName or Vercel attemptId) is recorded in the orphan ledger as indeterminate even on `404`.
    - Any other status, timeout, or network error: indeterminate for that artifact regardless of phase.
  - The aggregate result returned to the caller combines the two per-artifact results:
    - Both artifacts confirmed deleted (or never deployed): `CREATE_FAILED { cleanedUp: true, attemptedArtifacts: ["B-name", "A-name"] }` (only the deployed subset is listed).
    - Any artifact indeterminate: `CREATE_FAILED_INDETERMINATE { artifacts: [{ name, kind: "worker-a"|"worker-b", cleanedUp: false, cause? }, ...], cleanedUp: false }`. The orphan ledger contains one row per indeterminate artifact.
  - The adapter schedules a **delayed re-verify per indeterminate artifact**: 60 seconds after an INDETERMINATE result it re-issues `GET` against each indeterminate artifact's identity and, if it now exists (a racing deploy materialized), fires a final DELETE. Worker A and Worker B are reverified independently because their materialization timing differs.

#### Durable orphan tracking (survives process crashes)

In-process delayed re-verify is necessary but not sufficient: a host crash, container restart, or kill-9 between detecting the failure and completing cleanup leaves a billable artifact behind. The adapter therefore persists pending orphans **durably** before declaring an INDETERMINATE result:

- **Orphan ledger storage — SQLite, single-host only:** `${config.orphanLedgerPath ?? "${HOME}/.koi/sandbox-orphans.db"}` — a `bun:sqlite` database. JSON files are unsafe even within one host because two failing creates from concurrent processes can read the same snapshot, each rewrite, and the last rename wins. SQLite gives us proper transactional read-modify-write with `BEGIN IMMEDIATE` + WAL handling cross-process contention via the OS-level lock SQLite already implements — for **processes that share the same filesystem**.
- **Multi-host coordination is NOT provided by the ledger:** the SQLite ledger covers single-host failure modes only. Hosts that do not share a filesystem (typical multi-machine deployments) each maintain their own ledger and cannot see each other's orphans. Multi-host coordination is intentionally **delegated to the provider-side ownership-tagged sweep** (next bullet): the nightly cron has authority over every artifact tagged `koi-managed:v1` + `koi-owner:${ownerId}`, regardless of which host originally created it, and is the authoritative cross-host backstop. The local SQLite ledger is the fast in-host reconciliation path; the tagged sweep is the slow cross-host one. The two together cover the deployment topologies operators actually run.
- **Operator-visible doc requirement:** `docs/L2/sandbox-cloudflare.md` and `sandbox-vercel.md` MUST include a section "Single-host vs multi-host orphan handling" stating these guarantees explicitly so operators don't assume the local ledger covers their fleet.
- **Schema (one table, two row variants discriminated by `provider`):**
  ```sql
  CREATE TABLE IF NOT EXISTS orphans (
    id TEXT PRIMARY KEY,                -- provider:scope:resource-id (deterministic; see below)
    provider TEXT NOT NULL,             -- "cloudflare" | "vercel"
    account_id TEXT,                    -- Cloudflare: required; Vercel: NULL
    team_id TEXT,                       -- Vercel: nullable; Cloudflare: NULL
    project_id TEXT,                    -- Vercel: required; Cloudflare: NULL
    owner_id TEXT NOT NULL,              -- adapter config.ownerId — used to namespace fleet for cross-tenant safety
    pair_uuid TEXT NOT NULL,             -- The shared per-pair UUID; both Worker A and Worker B rows for the same pair carry the same value
    artifact_kind TEXT NOT NULL,          -- "worker-a" | "worker-b" — which side of the pair this row represents
    script_name TEXT,                   -- Cloudflare: required (per-artifact: A or B name as appropriate)
    deployment_id TEXT,                 -- Vercel: NULL until discovered; recovery via attempt_id (per-artifact)
    deployment_url TEXT,                 -- Vercel: NULL until discovered (per-artifact)
    attempt_id TEXT,                     -- Vercel: required (per-artifact UUID written to deployment.meta.koi-attempt-id; A and B have DIFFERENT attempt_ids)
    empty_lookups INTEGER NOT NULL DEFAULT 0, -- Vercel reconciliation: consecutive empty lookups before row removal
    last_empty_lookup_at TEXT,           -- Vercel reconciliation: timestamp of most recent empty lookup
    created_at TEXT NOT NULL,
    last_tried_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_orphans_provider_scope ON orphans (provider, account_id, team_id, project_id, owner_id);
  CREATE INDEX idx_orphans_pair_uuid ON orphans (pair_uuid);
  ```
  **One row per artifact, never per pair.** A failed-create flow that leaks both Worker A and Worker B writes TWO rows sharing the same `pair_uuid` but with distinct `artifact_kind`, distinct `script_name`/`attempt_id`, and independent reconciliation state. This matters because Worker A and Worker B's deploy POSTs can independently time out at different steps; each has its own deterministic recovery key (CF: per-artifact `script_name` set before the PUT; Vercel: per-artifact `attempt_id` written to that artifact's `meta.koi-attempt-id` before its POST), so each must persist independently or its identity is unrecoverable. The `pair_uuid` index lets reconciliation correlate the pair when one side completes and the other is still pending — but the rows are deleted independently as their respective DELETEs confirm.

  `id` is `cloudflare:${accountId}:${script_name}` or `vercel:${teamId ?? "_personal"}:${projectId}:${attempt_id}` — deterministic and known **before** the deploy POST is issued for THAT artifact, so the orphan can be persisted on any failure path including create timeouts where `deploymentId` was never returned. `deploymentId`/`deploymentUrl` are stored as updatable attributes that get filled in once the post-timeout `GET /v6/deployments?meta-koi-attempt-id=...` lookup discovers them. Cloudflare uses `script_name` (deterministic by construction, one per artifact); Vercel uses `attempt_id` (deterministic by construction, one per artifact — A and B have separate UUIDs). Both keying schemes are independent of any server-assigned identifier.

  **Adversarial test (mandatory):** `__tests__/vercel-paired-create-timeout.test.ts` exercises three scenarios: (1) Worker B deploy timeout — assert one row written with `artifact_kind="worker-b"` and the row's `attempt_id` is recoverable; (2) Worker B succeeds, Worker A deploy timeout — assert TWO rows written (one per artifact, distinct attempt_ids, same pair_uuid) and reconciliation deletes both; (3) host crash between B's row write and A's row write — assert the next adapter start finds B's row, completes recovery, and that A's leaked deployment is also discovered via Vercel-side scan for `koi-managed:v1` + `koi-pair-uuid` tag. Test must pass for every PR touching the orphan ledger.
- **Atomic operations:** all writes wrap `BEGIN IMMEDIATE; ... COMMIT;` so concurrent adapter instances cannot interleave. Reconciliation deletes a row in the same transaction that confirms the provider DELETE returned success — no read-then-delete window.
- **WAL mode + per-orphan FULL synchronous + explicit fsync:** the database opens with `PRAGMA journal_mode=WAL`. The default `PRAGMA synchronous=NORMAL` is fine for read-heavy paths, but the orphan-insert transaction is wrapped in a session-scoped `PRAGMA synchronous=FULL` so commits force fsync on both the WAL and the database file. The transaction then explicitly calls `db.exec("PRAGMA wal_checkpoint(FULL); PRAGMA synchronous=NORMAL")` after commit to restore the default for subsequent reads. This guarantees an orphan row is durably on disk before the adapter returns INDETERMINATE — `kill -9` immediately after the function returns cannot lose the row, because the kernel has confirmed the disk write completed.
- **Crash-recovery test (mandatory):** `__tests__/orphan-ledger-crash.test.ts` simulates a hard crash by spawning a subprocess that begins an orphan-record transaction, fsyncs, then is killed with `SIGKILL` from the parent. The parent reopens the database and asserts the orphan row is present. CI runs this test on every PR that touches the ledger code; failure blocks merge.
- **Downgraded API claim:** the documented guarantee is "an orphan recorded by the adapter survives any single-host crash including SIGKILL after the adapter call returns." Multi-disk failures, filesystem corruption, and storage-layer dataloss are out of scope and acknowledged in `docs/L2/sandbox-cloudflare.md` as residual risks beyond the ledger's coverage.
- **Write-before-return invariant:** an INDETERMINATE result is only returned to the caller AFTER the orphan has been persisted to the ledger. If the ledger write itself fails, the adapter blocks and retries (bounded) before returning a strictly-stronger error `KoiError { code: "ORPHAN_LEDGER_WRITE_FAILED" }` with the artifact identity in context. Caller knows operator intervention is required immediately.
- **Reconciliation on adapter init:** at construction time, each adapter reads the ledger and matches entries by its provider-specific ownership key, **including `ownerId` to prevent cross-tenant interference**:
  - Cloudflare: `provider === "cloudflare" && accountId === config.accountId && owner_id === config.ownerId`.
  - Vercel: `provider === "vercel" && (teamId ?? null) === (config.teamId ?? null) && projectId === config.projectId && owner_id === config.ownerId`.
  An adapter NEVER deletes a row whose `owner_id` does not match its own configured `ownerId`, even if `accountId`/`projectId` match — different fleets sharing one provider account or one filesystem retain isolation through the local ledger.
  - Each matched orphan triggers a provider-specific DELETE:
    - **Cloudflare:** `DELETE /workers/scripts/{scriptName}` (deterministic key already present).
    - **Vercel — `deployment_id` present:** `DELETE /v13/deployments/{deploymentId}` directly.
    - **Vercel — `deployment_id` NULL (timeout/crash before discovery):** the reconciliation path FIRST issues `GET /v6/deployments?meta-koi-attempt-id=${attempt_id}&teamId=${teamId}` to discover `deploymentId`.
      - **Lookup found a deployment:** persist `deploymentId` to the row, then DELETE.
      - **Lookup returned empty (deploy may not have materialized yet — Vercel control-plane is eventually consistent):** treated as **indeterminate**, NOT as proof of non-existence. Increment `empty_lookups` counter (new schema column, defaults to 0) and update `last_tried_at`. The row is removed only after **3 consecutive empty lookups separated by at least 10 minutes each** (i.e., a sustained 30-minute observation window). Earlier removal is forbidden because the only durable recovery key would be lost if the deployment materializes after the lookup.
      - **Lookup itself fails (network error, rate limit, 5xx):** bump `lastTriedAt`, increment `attempts`, retain the row with exponential backoff (`2^min(attempts,6) * 1000ms` until the next reconcile pass). NEVER counted as an empty lookup. After 24 hours of repeated failure, the row is annotated `stuck=true` and surfaced in operator logs but still retained.
      - The `empty_lookups` column is reset to 0 on any non-empty result (including failures) so a single materialized observation always triggers DELETE on the next pass.
  - Successful deletions (or 404 confirmed by a follow-up GET) remove the entry; failures bump `lastTriedAt` and stay queued.
  - The Vercel adapter requires `projectId` AND `ownerId` in its config so reconciliation has both a deterministic key and a namespace — neither is optional.
- **Ownership-tagged artifacts + heartbeat lease (cleanup gated on staleness, not just tags):** every create attempt tags the deployed artifact with provider-side metadata identifying it as koi-managed AND a heartbeat lease tag that says "this artifact is in active use until time X". **Canonical metadata schema (single source of truth — every cleanup invariant in this doc references these field names):**
  - **Cloudflare:** Workers `tags` field on the script: `["koi-managed:v1", "koi-owner:${ownerId}", "koi-host-uuid:${hostUUID}", "koi-process-instance:${processInstanceId}", "koi-pair-uuid:${pairUUID}", "koi-artifact-kind:worker-a"|"worker-b", "koi-stale-after:${ISO_TIMESTAMP}"]`.
  - **Vercel:** `meta` object on deployments: `{ "koi-managed": "v1", "koi-owner": "${ownerId}", "koi-host-uuid": "${hostUUID}", "koi-process-instance": "${processInstanceId}", "koi-pair-uuid": "${pairUUID}", "koi-artifact-kind": "worker-a"|"worker-b", "koi-stale-after": "${ISO_TIMESTAMP}" }`.
  - **Field semantics:**
    - `koi-managed:v1` — adapter-managed marker; sweep ignores any artifact lacking it.
    - `koi-owner:${ownerId}` — fleet namespace; sweep only deletes artifacts whose owner matches the configured one.
    - `koi-host-uuid:${hostUUID}` — REQUIRED. Identifies the host (machine/VM) that originally created the artifact. **Telemetry only — NOT used as a cleanup gate.** A same-host restart reuses `hostUUID`, so it cannot distinguish the dead process's orphans from the live process's artifacts. `koi-process-instance` is the authoritative cleanup-gate field; `koi-host-uuid` is retained purely for fleet observability (which physical host produced an artifact).
    - `koi-process-instance:${processInstanceId}` — REQUIRED. **Fresh UUID generated at every adapter construction** — distinct from `hostUUID`. The Vercel reconciler's false-delete guard checks this against the current holder of `koi:vercel:exclusive:${ownerId}` (whose value is also `processInstanceId`, NOT `hostUUID`). On same-host restart, the new process generates a new `processInstanceId` and acquires the lease; the dead process's artifacts carry the old `processInstanceId`, which no longer matches the lease holder, so the reconciler can delete them once the confirmation window elapses. Cloudflare's fleet sweeper uses it for telemetry only (CF's safety gate is the bounded DO-alarm liveness, not process identity).
    - `koi-pair-uuid:${pairUUID}` — REQUIRED. Shared by both Worker A and Worker B in the same pair so the sweeper, given one half, can locate the other (`GET /workers/scripts?tag=koi-pair-uuid:${pairUUID}` on CF; `GET /v6/deployments?meta-koi-pair-uuid=${pairUUID}` on Vercel). The orphan-ledger `pair_uuid` index is the in-host equivalent.
    - `koi-artifact-kind` — `"worker-a"` or `"worker-b"`. Lets DELETE-ordering logic identify which side is which without parsing names.
    - `koi-stale-after:${ISO_TIMESTAMP}` — heartbeat lease deadline.
  - **Failure mode if any required field is missing:** the sweeper/reconciler MUST treat the artifact as `untagged-koi-artifact` and refuse to delete it. Missing fields are an indication of an externally-created artifact or an adapter-version mismatch — neither is safe to delete. Adversarial test: `__tests__/sweeper-skips-incomplete-metadata.test.ts` deploys an artifact missing `koi-host-uuid` and asserts the sweeper logs and skips it.
  - **Adversarial test for pair recovery:** `__tests__/sweep-recovers-pair-from-one-half.test.ts` deletes one orphan-ledger row before sweep runs (simulating a crash before both rows persisted); asserts the sweeper queries `koi-pair-uuid` on the surviving half, discovers the missing artifact provider-side, and DELETEs both. Test must pass for every PR touching the sweep code.
  **Single source of truth for Cloudflare lease parameters (used everywhere in this doc):**
  - Lease window: **15 minutes** (`koi-stale-after = now + 15 minutes` at create; renewed to `now + 15 minutes` on each successful PATCH).
  - Host-side renewal cadence: **every 2 minutes** with a 30-second PATCH timeout.
  - Renewal tolerance: up to **3 consecutive failures (~6 minutes)** before the local handle poisons; the lease itself only expires after 15 minutes regardless of host renewals, which is what backstops the sweeper.
  - Fleet sweeper cadence: **every 1 minute** (Cloudflare Cron Trigger).
  - **Host-originated DO lease cadence:** every 5 minutes the host issues `POST https://${A-name}.${subdomain}.workers.dev/__do_lease` (deployed Worker A runtime URL, bearer-authenticated with `KOI_INSTANCE_TOKEN`) to refresh `host-lease-until = now + 30 minutes` inside Worker A's DO. (The control-plane API path is NOT used.) This is the SECOND host-originated signal that gates the DO alarm callback (specified below). Two host signals are required: PATCH for `koi-stale-after`, POST for `__do_lease`.
  - Worst-case post-crash leak window: 30-minute `host-lease-until` + 90-second `worker-alive` natural TTL + 1-minute sweep ≈ **32 minutes** on Cloudflare. The 15-minute `koi-stale-after` lease alone is NOT the bound because the DO-alarm `worker-alive` backstop keeps refreshing until `host-lease-until` expires. Both gates (`koi-stale-after` past AND `worker-alive` stale) must hold before sweep deletes — that is what closes the false-kill case during control-plane outages.

  **Vercel lease parameters (single source of truth):**
  - Per-instance `koi-stale-after` lease: **30 minutes**, host renewal every **5 minutes** with a 30-second timeout, **5 consecutive renewal failures (~25 minutes)** tolerated before the local instance handle poisons. (Math: 5 × 5 min = 25 min — these match.)
  - Fleet-exclusivity lease: **90-second TTL**, host renewal every **30 seconds**, **2 consecutive renewal failures (~60 seconds wall clock)** tolerated before the adapter poisons all live instances with `VERCEL_FLEET_EXCLUSIVITY_LOST`. Poison fires at least **30 seconds before** the lease's natural 90-second TTL elapses, closing the split-brain window at the boundary. (Math: 2 × 30 sec = 60 sec poison; 60 sec + 30 sec margin = 90 sec lease — these match.) The earlier "3 consecutive failures (~90 seconds)" number is REPLACED — it allowed an old host to keep serving until exactly the moment a new host could acquire the lease. Every restating site (acceptance checklist, L2 docs, tests) uses 2-failure / 60-second poison.
  - Reconciler heartbeat: **90-second TTL**, reconciler refreshes every **30 seconds**, adapter polls every **60 seconds**, **5 consecutive missed checks (~5 minutes)** tolerated before the adapter poisons all live instances with `VERCEL_RECONCILER_LOST`. (Math: 5 × 60 sec = 300 sec — these match.)
  - Reconciler delete-confirmation window past `koi-stale-after`: **30 minutes**.
  - Post-crash leak window: **UNBOUNDED — no contract, no guarantee.** The frequently-quoted "~65 minutes" figure is best-effort telemetry derived from (30-minute lease + 30-minute reconciler confirmation + 5-minute reconciler cadence) and is observed only when the reconciler topology happens to satisfy operator-attested isolation. It MUST NOT be cited as a bound, because the adapter cannot mechanically verify that attestation. Every restating site treats Vercel cleanup as unbounded; the 65-minute figure appears only as parenthetical telemetry, never as a contract.

  On `destroy()` the entire artifact is deleted. On host crash, the tag stops renewing and naturally expires; any sweeper picks it up once `koi-stale-after` is in the past.
- **Continuous sweep, not nightly:** the sweep is NOT a once-a-day cron. A continuous-mode sweeper runs every minute (configurable) and immediately deletes any artifact whose `koi-stale-after` has passed.
- **Cloudflare uses a single fleet-scoped sweeper worker (NOT a cron in every instance):** the cleanup cron is NOT embedded in per-instance Worker A — that would scale linearly with instance count and cause sweep/renewal interference + API rate-limit issues. Instead, the koi adapter deploys ONE long-lived **fleet sweeper** worker per `ownerId`: `koi-sandbox-cleanup-${ownerId}`. This worker has the same Cloudflare Cron Trigger (every minute) and is the ONLY artifact in the account that scans for stale `koi-managed:v1` + `koi-owner:${ownerId}` workers and deletes them.
  - **Sweeper existence is verified before every `create()`, no caching.** `GET /workers/scripts/koi-sandbox-cleanup-${ownerId}` is issued at the start of every `create()` call. If the sweeper is absent, the adapter deploys it from the package's fixed source template before proceeding with the per-instance create state machine. The earlier draft cached the existence check for an hour — that introduced a window in which a self-deleted sweeper could leave newly-created instances without a backstop. The cache is removed; the per-create GET is single-digit-millisecond round-trip and not a measurable cost vs. the multi-second Worker deploy that follows.
  - **The sweeper does NOT self-delete.** The earlier "self-delete when zero managed workers remain" rule is removed because it created the same backstop gap: a long-lived adapter with a cached positive existence check could call `create()` against an account whose sweeper had self-deleted, deploying new instances that no sweeper was watching. The sweeper instead remains as a fleet-scoped permanent artifact, owned per `ownerId`. If an operator wants to fully shut down a fleet they invoke `@koi/sandbox-sweep --teardown --cloudflare --owner-id=${ownerId}`, which deletes the sweeper as the explicit final step after asserting zero managed workers remain.
  - Per-instance Worker A focuses on invoke/dedupe only — no cron trigger, no scanning. This bounds account-wide API traffic to one minute-by-minute scan regardless of instance count.
  - Cross-host leak window matches the single-source-of-truth above: ≈ **32 minutes** maximum on Cloudflare (30-minute `host-lease-until` + 90s `worker-alive` TTL + 1-minute sweeper cadence). The 15-minute `koi-stale-after` is the FIRST gate; the DO-alarm worker-alive is the SECOND gate; both must be stale before deletion.
- **Vercel ships single-host only in this PR. Multi-host mode is explicitly NOT supported.** Vercel has no per-instance scheduled-execution primitive (project-level cron is 1-minute minimum and hits a production URL only) and no provider-side TTL. Without a worker-originated liveness signal, any sweeper that deletes on stale lease alone CAN delete healthy live deployments during a control-plane outage. We refuse to ship that data-loss path, so:
  - `createVercelAdapter(config)` requires `config.multiHostMode: "single-host"` and rejects every other value with `KoiError { code: "VERCEL_MULTI_HOST_UNSUPPORTED" }` at construction. There is no `"multi-host-with-sweeper"` runtime mode.
  - `"single-host"` mode enforces exclusivity through **TWO gates that must BOTH succeed**, neither alone is sufficient:
    1. **Local OS file lock** (`flock` on `/var/lock/koi-sandbox-vercel.lock` or equivalent): prevents two adapter processes on the same host. This is necessary but not sufficient — a local lock on machine A says nothing about machine B.
    2. **Fleet-wide exclusivity lease in Vercel KV** (the same KV used for dedupe): the adapter performs an ownership-checked `SET koi:vercel:exclusive:${ownerId} ${processInstanceId} NX EX 90` via Lua at construction, then renews via ownership-checked Lua (`if GET == ARGV[1] then PEXPIRE ... else return 0`) every 30 seconds. **Lease value is `processInstanceId` (fresh per adapter construction), NOT `hostUUID`** — a same-host restart writes a different value, which is what allows the reconciler to identify the dead process's orphans (per the per-process-instance cleanup gate above). If `SET NX` fails (someone else holds the lease) the adapter refuses to start with `KoiError { code: "VERCEL_FLEET_EXCLUSIVITY_HELD", currentHolder: <opaque> }`. If a renewal Lua returns 0 mid-operation (lease taken over because this process's heartbeat lapsed), every active `EdgeFunctionInstance` transitions to **POISONED** with `KoiError { code: "VERCEL_FLEET_EXCLUSIVITY_LOST" }` — only `destroy()` is permitted thereafter. Both gates fail-closed: if Vercel KV is unreachable at construction, the adapter rejects with `KoiError { code: "VERCEL_KV_UNREACHABLE" }` rather than running unsafely.
    - The **fleet-wide exclusivity lease IS the cross-host coordination primitive**. The earlier draft incorrectly claimed `flock` alone enforced cross-host exclusivity — a local lock on host-local disk does not. With both gates required, two machines pointed at the same `ownerId` cannot both run: machine B's `SET NX` returns null because machine A holds the lease.
    - **Fail-closed on KV partition (timing math, single source of truth):** the exclusivity-lease renewal cadence is **30 seconds**; the lease TTL is **90 seconds**. Up to **1 consecutive renewal failure (~30 seconds)** is tolerated; **on the 2nd consecutive failure (~60 seconds wall clock) the adapter POISONs** every active instance with `VERCEL_FLEET_EXCLUSIVITY_LOST`. Poison fires **at least 30 seconds before the lease's natural 90-second TTL elapses**, so a second host cannot legally acquire the lease while the first host is still serving traffic. The earlier "poison after 3 consecutive failures (~90s)" rule allowed the old host to keep serving until almost exactly the moment a new host could acquire the lease — a split-brain window at the boundary. With the new 60s-poison-vs-90s-TTL margin, the old host has stopped accepting invokes for at least 30 seconds before the new host's `SET NX` can succeed. The three constants — **renewal 30s, TTL 90s, poison after 2 consecutive failures (~60s)** — are the SOLE source of truth for exclusivity-lease timing.
    - **Lease-epoch fencing on every KV mutation (defense-in-depth against the residual boundary).** Even with the 30s margin above, every dedupe-related Vercel KV mutation (`CHECK_OR_CLAIM_LUA`, `HEARTBEAT_LUA`, `COMMIT_LUA`, `FAIL_LUA`, `RELEASE_LUA`) reads `koi:vercel:exclusive:${ownerId}` atomically and refuses to mutate if the current holder is not this process's `processInstanceId`. Concretely, every Lua script gets prefixed with: `local h = redis.call('GET', '${exclusivityKey}'); if h ~= ARGV[N] then return 'fenced:'..tostring(h) end`. The shim, on receiving `fenced:`, returns HTTP 409 with `X-Koi-Result-Kind: lease-fenced` and the host adapter maps to `KoiError { code: "VERCEL_FLEET_EXCLUSIVITY_LOST" }`. Two hosts that briefly overlap at the lease-boundary therefore CANNOT both write to the same dedupe records — only the lease holder's mutations succeed, the loser's mutations no-op. This closes the residual split-brain window even if the timing margin is violated by clock skew or pause-the-world events. **Adversarial test (mandatory):** `__tests__/vercel-lease-fencing.test.ts` simulates a forced split-brain by directly overwriting the exclusivity key mid-handler-execution and asserts the in-flight mutation returns `lease-fenced` and never persists.
    - **Adversarial test (mandatory):** `__tests__/vercel-fleet-exclusivity.test.ts` (1) starts adapter A, asserts the Vercel KV exclusivity key is set; (2) starts adapter B against the same `ownerId` and asserts it rejects with `VERCEL_FLEET_EXCLUSIVITY_HELD`; (3) kills adapter A's process abruptly; (4) waits past the 90-second lease TTL; (5) starts adapter C and asserts it succeeds. Test must pass for every PR touching Vercel exclusivity code.
    - The legacy `VERCEL_HOST_LOCK_HELD` error code (local-only conflict) is reserved for the in-host `flock` failure path; cross-host conflicts surface `VERCEL_FLEET_EXCLUSIVITY_HELD`.
  - **Multi-host is a future PR**, gated on at least one of the following becoming available: (a) a Vercel worker-internal scheduled-execution primitive equivalent to CF DO Alarms, (b) a Vercel provider-side TTL on deployments, or (c) an authoritative inbound liveness probe the sweeper can issue against an unprotected health endpoint without breaking Worker B's structural privacy. Until then, `multi-host-with-sweeper` is not exposed.
  - `docs/L2/sandbox-vercel.md` MUST state in its first section: "This adapter supports single-host operation only. Multi-host fleets are not supported in this release."
  - **Adversarial test (mandatory):** `__tests__/vercel-multi-host-rejected.test.ts` constructs the adapter with every multi-host config value and asserts each rejects with `VERCEL_MULTI_HOST_UNSUPPORTED`. Test must pass for every PR that touches Vercel adapter construction.
  - This deliberately removes the sweeper-heartbeat / sweeper-loss / SWEEPER_LOST machinery from the v1 surface. Those terms are removed from the implementation contract; if reintroduced in a future PR they will require a worker-originated liveness signal that does not exist today.
  Artifacts created outside this adapter (or by other tools) lack the `koi-managed:v1` tag and are NEVER touched by any sweep.
- **External reconciliation (provider-specific deletion predicate — single source of truth, see CF/Vercel-specific subsections below for the authoritative full predicate):** the cron job lists scripts/deployments where `koi-managed=v1` AND `koi-owner=${expectedOwnerId}` AND `koi-stale-after` is in the past. **Stale `koi-stale-after` is necessary but NOT sufficient on its own.** Each provider adds a second mandatory gate:
  - **Cloudflare:** sweeper deletes only when `koi-stale-after` is past AND the `worker-alive` DO-backed liveness signal has gone stale. The DO-alarm liveness gate is itself bounded on a host-originated `host-lease-until` (see CF liveness section). Both gates must hold.
  - **Vercel:** reconciler deletes only when `koi-stale-after` is past AND the artifact's stamped `processInstanceId` is no longer the holder of `koi:vercel:exclusive:${ownerId}` AND `koi-stale-after` has been past for at least 30 minutes (the confirmation window). All three gates must hold.
  Long-lived active instances renew their `koi-stale-after` lease and are never swept regardless of age. The earlier "stale-after alone is enough" wording is REMOVED — that rule would have allowed a control-plane renewal outage to delete a still-serving worker.
  - The sweep additionally consults the local SQLite ledger to skip rows with `last_tried_at` within 5 minutes (some other host is actively reconciling).
- **Cloudflare lease parameters (restating the single source of truth above for outage-tolerance analysis):** lease 15 minutes, renewal every 2 minutes, 3-failure tolerance (~6 minutes) before the local handle poisons. These are tuned so transient control-plane outages cannot cause the sweeper to kill healthy artifacts:
  - The host attempts a PATCH renewal every 2 minutes with a 30-second timeout.
  - A SINGLE missed renewal does NOT poison or sweep. Up to 3 consecutive failures over ~6 minutes are tolerated. After 3 consecutive misses, the host marks the local handle as POISONED and stops accepting new invokes (defense in depth — at this point control plane has been down for many minutes and the artifact's reachability is suspect anyway). The lease itself remains valid for the full 15 minutes and is what gates the sweeper.
  - **Worker-originated liveness signal — Cloudflare only, BOUNDED on host ownership:** on Cloudflare, Worker A writes a `worker-alive` heartbeat to a DO storage key `${ownerId}:alive:${pairUUID}` with a 90-second TTL refreshed every 30 seconds via the DO `setAlarm` API. **The DO does NOT self-refresh indefinitely**; the alarm callback is gated on a host-originated lease that the host must renew separately:
    - **Host-originated DO lease:** every 5 minutes the host issues `POST https://${A-name}.${subdomain}.workers.dev/__do_lease` against the **deployed Worker A runtime URL** (NOT the Cloudflare control-plane API). The bearer-authenticated request hits Worker A's `fetch` handler, which routes the path `/__do_lease` to a DO method that writes `host-lease-until = now + 30 minutes` to the same DO's storage. The same `Authorization: Bearer ${KOI_INSTANCE_TOKEN}` mechanism that protects `/invoke` protects this path; Worker A's request router rejects unauthenticated `/__do_lease` calls with 401. The earlier draft's `/workers/scripts/${A-name}/__do_lease` URL was incorrect — that is the Cloudflare control-plane API path, which cannot route into Worker A's runtime. The corrected runtime endpoint is the one specified here, and every other reference to `__do_lease` in this document means this runtime path. Rate-limited to once per minute per pair to prevent unbounded write traffic.
    - **Alarm callback gate:** when the DO alarm fires, the callback reads `host-lease-until`. If `host-lease-until > now`, it refreshes `worker-alive` and schedules the next alarm. If `host-lease-until <= now`, the callback does NOT refresh the key, does NOT schedule the next alarm, and the alive key expires at its natural 90-second TTL. The alarm chain stops — no more self-refresh.
    - **Net behavior:** a host hard-crash stops the 5-minute `__do_lease` calls. Within at most 30 minutes (the host-lease-until window) the DO alarm callback observes the expired lease and stops refreshing. After the alive key's 90-second natural TTL, the sweeper observes both `koi-stale-after` past AND `worker-alive` stale, and DELETEs.
    - **Worst-case post-crash leak window: 30 minutes (host-lease-until) + 90 seconds (alive TTL) + 1 minute (sweeper cadence) ≈ 32 minutes.** The earlier "16 minutes" claim was inconsistent with the DO-alarm self-refresh; the corrected number is 32 minutes and is now used in every restating site.
    - **A control-plane outage that prevents host PATCH renewals (but not host `__do_lease` calls) leaves the DO refreshing alive — sweeper correctly skips.** The two host signals (PATCH renew of `koi-stale-after` AND POST `__do_lease`) are both required to be failing before sweep concludes the host is dead. This is the false-kill protection the design relies on.
    - **Adversarial test (mandatory):** `__tests__/cf-do-alarm-host-ownership.test.ts` asserts (a) DO alive key refreshes while host is alive; (b) host `__do_lease` calls stopped → DO alarm chain halts within 30 minutes; (c) alive key expires within ~32 minutes total; (d) sweeper deletes artifact within 32 minutes of host crash. Test must pass for every PR that touches CF DO alarm code.
  - **Vercel sweep model (single authoritative path):** Vercel cleanup is performed exclusively by the **always-on external reconciler** (`koi-sandbox-sweep --watch --vercel --owner-id=${ownerId}`), not by any in-process sweeper inside the adapter. The earlier draft described an in-process sweeper as an alternative; that alternative is removed because it could not recover crashed hosts and introduced an ambiguous second cleanup authority. The reconciler is the single source of truth for Vercel cleanup. The adapter itself runs no sweep loop — its only background loops are the lease-renewal loop, the exclusivity-lease loop, and the reconciler-heartbeat poller. The reconciler's protocol and runtime-prerequisite enforcement are specified in the next bullet.
  - **Leak window after host hard-crash** differs sharply by provider, because each provider's sweep model differs:
    - **Cloudflare ≈ 32 minutes** (30-minute `host-lease-until` window + 90s alive TTL + 1-minute sweep). The fleet sweeper is a permanent CF Worker with a Cron Trigger; it runs in the Cloudflare account independent of any koi adapter process, so a host hard-crash with no adapter restart still gets cleaned up within the bound. The DO-alarm liveness gate is **bounded on a host-originated 30-minute lease** (specified below) so a crashed host cannot keep the alive key fresh indefinitely.
    - **Vercel: post-crash leak window is UNBOUNDED until operator intervention.** Because the adapter cannot mechanically verify failure-domain separation between adapter host and reconciler host, the spec **does not advertise a bounded-cleanup guarantee** for Vercel. Best-case reconciler-runs-cleanly observed cleanup is ~65 minutes (30-minute lease + 30-minute reconciler confirmation window + 5-minute reconciler cadence), but operators MUST treat this as best-effort, not a contract. **Vercel ships behind a non-production gate.** `createVercelAdapter(config)` requires `config.unsafelyEnableExperimentalProvider: true` AND rejects construction in any environment that sets `KOI_ENV=production` (or equivalent runtime indicator) with `KoiError { code: "VERCEL_PRODUCTION_USE_FORBIDDEN" }`. The L2 doc states in its first section: "The Vercel adapter is EXPERIMENTAL. It is NOT production-ready and MUST NOT be used in any production environment. Cleanup of internet-reachable Worker B deployments after host failure is not bounded — a shared failure of adapter and reconciler can leave authenticated public deployments alive indefinitely." The flag name and production-env reject are deliberately ugly to deter copy-paste use. Provisional ship status will be lifted only when (a) Vercel exposes a provider-owned cleanup primitive (deployment TTL, scheduled-execution primitive equivalent to CF DO Alarms, or authoritative inbound-liveness probe), OR (b) a mechanically-verifiable isolation/fencing mechanism is added to this design. Until then, operators who require bounded cleanup MUST use the Cloudflare adapter instead. **CI gate:** `__tests__/vercel-production-use-forbidden.test.ts` asserts that (i) construction rejects with `VERCEL_PRODUCTION_USE_FORBIDDEN` when `KOI_ENV=production` regardless of `unsafelyEnableExperimentalProvider`, and (ii) construction rejects with `VERCEL_EXPERIMENTAL_NOT_ENABLED` when the flag is absent.
  - **Vercel reconciler is a hard runtime prerequisite; failure-domain isolation is operator-attested, NOT provably enforced:** the adapter REQUIRES that an always-on reconciler is running and writing a heartbeat to Vercel KV. The reconciler MUST run on a separate failure domain from every adapter host, but the adapter cannot independently verify "separate failure domain" (hostname-mismatch is a necessary heuristic, not a proof — two containers on the same VM have different hostnames yet share a failure domain). Enforcement is layered:
    - **Operator-supplied failure-domain identifier (explicit, not heuristic):** adapter config requires `config.failureDomainId: string` — an opaque identifier the operator declares for the failure domain hosting this adapter (e.g., `"k8s-cluster-east-1/node-pool-app-7"`, `"vm-prod-edge-3"`, `"region-us-east"`). The reconciler is configured with its OWN `failureDomainId` and writes it to `koi:vercel:reconciler:failure-domain:${ownerId}` at startup. The adapter rejects construction if its declared `failureDomainId` matches the reconciler's (`KoiError { code: "VERCEL_RECONCILER_SAME_FAILURE_DOMAIN" }`). Hostname-based matching has been removed: it caught only the trivial container-equality case while admitting same-VM/same-node colocations with different hostnames. The operator IS the source of truth for the failure-domain identity; the spec cannot independently verify "different VM" or "different region", so the operator's declared id is the contract.
    - **Operator-attested isolation contract:** adapter config additionally requires `config.reconcilerIsolationAttested: true`. Setting it is the operator's explicit acknowledgment: "the `failureDomainId` values I have declared accurately reflect distinct failure domains." The adapter rejects construction if this is false/unset (`KoiError { code: "VERCEL_RECONCILER_ISOLATION_NOT_ATTESTED" }`). The combination of explicit `failureDomainId` + attestation forces the operator to (a) name the failure domain so review/audit can verify it, and (b) explicitly confirm the topology — neither is provably enforceable by the adapter, but together they make a misconfigured deployment auditable rather than silent.
    - **There is NO bounded-cleanup guarantee for Vercel.** The L2 doc states this explicitly: "Cleanup of internet-reachable Worker B deployments after host failure is not bounded by this adapter. The frequently-quoted ~65-minute observation (30-minute lease + 30-minute reconciler confirmation + 5-minute reconciler cadence) is best-effort telemetry that is observed ONLY when the reconciler runs on a failure domain that does not share fate with any adapter host — and the adapter cannot independently verify this. Operators MUST NOT treat ~65 minutes as a contract. Recommended deployments to maximize the chance the telemetry holds: a different VM/container on a different machine, a different k8s node, a different region, or a managed-cron platform with independent failure domain (GitHub Actions, AWS EventBridge, Render Cron) — but the contract remains unbounded regardless."
    - Verification of the runtime-prerequisite (heartbeat presence) follows the same lease-renewal pattern used for fleet exclusivity:
    - Reconciler heartbeat key: `koi:vercel:reconciler:heartbeat:${ownerId}` with 90-second TTL, refreshed every 30 seconds by `koi-sandbox-sweep --watch --vercel --owner-id=${ownerId}`.
    - Adapter verifies the heartbeat at construction; missing/stale → reject with `KoiError { code: "VERCEL_RECONCILER_NOT_RUNNING", remediation: "run koi-sandbox-sweep --watch --vercel --owner-id=${ownerId} on a long-lived host before constructing this adapter" }`.
    - Adapter polls the heartbeat continuously (60-second background timer); 5 consecutive missed checks (~5 minutes) → all live `EdgeFunctionInstance`s POISONED with `KoiError { code: "VERCEL_RECONCILER_LOST" }`. Only `destroy()` is permitted thereafter.
    - The reconciler verification is **separate from** the fleet-exclusivity lease (`koi:vercel:exclusive:${ownerId}`): the exclusivity lease ensures only one adapter is creating instances; the reconciler heartbeat ensures an always-on cleanup process is observing the fleet. Both must be satisfied for the adapter to operate.
  - **Reconciler false-delete protection (compensates for no per-instance liveness signal):** the reconciler does NOT delete on `koi-stale-after` alone. It deletes ONLY when ALL of the following are true:
    1. Artifact's `koi-stale-after` has passed.
    2. AND artifact's `koi-stale-after` has been past for at least **30 minutes** (the confirmation window — a control-plane outage shorter than this NEVER triggers deletion).
    3. AND the **process-instance ID** stamped on the artifact's `koi-process-instance` metadata is NOT the current holder of `koi:vercel:exclusive:${ownerId}`. **`processInstanceId` is a fresh UUID generated at every adapter construction** — NOT `hostUUID`. A same-host restart (process crash + supervisor restart on the same VM) generates a NEW `processInstanceId`; the new adapter writes the new id into the exclusivity lease via `SET NX EX 90`, but only after the old process's lease has expired (90s natural TTL after the crash). Artifacts created by the dead process carry the OLD `processInstanceId`, which no longer matches the lease holder → reconciler is permitted to delete them. The earlier draft used `hostUUID` for this gate, which made post-restart cleanup impossible because the new process reused the same `hostUUID` and old artifacts looked owned forever. `hostUUID` remains a separate metadata field for telemetry only — `koi-process-instance` is the authoritative cleanup gate.
    Combined: a process hard-crash releases the exclusivity lease (within the lease's natural 90-second TTL); the supervisor restarts a new adapter process, which generates a fresh `processInstanceId` and acquires the lease; 30 minutes after `koi-stale-after`, the reconciler observes both gates (the dead process's `processInstanceId` is no longer the lease holder, and `koi-stale-after` is past+30min) and DELETEs the orphaned artifacts. A control-plane outage that prevents PATCH renewals does NOT release the exclusivity lease (the host is still running its exclusivity-renewal Lua), so the reconciler skips. Net: the false-delete window the earlier multi-host design admitted is closed by the per-host-UUID gate.
  - **Adversarial test (mandatory):** `__tests__/vercel-reconciler-required.test.ts` asserts (a) adapter rejects with `VERCEL_RECONCILER_NOT_RUNNING` if no heartbeat present at construction; (b) adapter poisons all live instances after 5 missed reconciler heartbeats with `VERCEL_RECONCILER_LOST`; (c) reconciler sweep does NOT delete artifacts whose `processInstanceId` still holds the exclusivity lease, even after `koi-stale-after` + 30-minute confirmation window expires; (d) reconciler DOES delete artifacts whose `processInstanceId` has lost the exclusivity lease AND `koi-stale-after` + 30-min has expired; (e) **same-host restart cleanup**: kill the adapter process, wait 90s for exclusivity-lease TTL, restart adapter on the same host (same `hostUUID`, fresh `processInstanceId`), wait `koi-stale-after` + 30 min, assert the dead process's artifacts ARE deleted by the reconciler. CI runs all five scenarios on every PR that touches Vercel sweep code.
  - `docs/L2/sandbox-vercel.md` documents the operational requirement as: "Run `koi-sandbox-sweep --watch --vercel --owner-id=${ownerId}` on a long-lived host (operator-managed VM, k8s deployment, or equivalent — NOT a Vercel deployment) before constructing any Vercel adapter. The adapter refuses to start without an active reconciler." Includes example k8s/systemd/launchd manifests in the same doc.
- **Adversarial test (mandatory):** `__tests__/sweep-control-plane-outage.test.ts` simulates a Cloudflare/Vercel control-plane API outage where host PATCH calls fail 503 for 10 minutes while the worker continues to serve invokes (worker-alive heartbeat stays fresh). Asserts the sweeper does NOT delete the artifact during the outage, and that invokes continue to succeed. CI runs this on every PR that touches lease/sweep code.
- **Tag-application failure is a create failure:** if the provider does not accept the tags during deploy (older API, plan limitation), `create()` returns `KoiError { code: "TAGS_UNSUPPORTED" }` and tears down. We refuse to deploy untracked artifacts.
- **Synchronous cleanup option:** for callers that cannot tolerate any deferred cleanup, config exposes `synchronousCreateCleanup: boolean` (default `false`). When `true`, the adapter does not return until either (a) the cleanup DELETE returns confirmed-deleted (success path), or (b) cleanup fails and the orphan is persisted to the ledger. INDETERMINATE results are never returned with a still-pending in-process re-verify scheduled — the caller blocks until the durable trace is written. This trades latency for an absolute guarantee that no artifact exists outside the ledger.
- **Idempotent retries are caller responsibility:** the adapter never auto-retries `create`. Each retry produces a new UUID and is independent.
- **No orphan from successful create then later failure:** once `ready`, only `destroy()` deletes; failures during `exec()` poison but do not auto-delete (caller decides).
- Endpoint: `https://api.cloudflare.com/client/v4/accounts/{accountId}/workers/scripts/{instanceScriptName}` for deploy/delete; deployed worker URL for invoke.
- Network: only `fetch` — no SDK dep.
- Instance (`EdgeFunctionInstance`):
  - Owns its own `scriptName` for Worker A (gateway) AND companion `scriptName` for Worker B (handler runner) — both private fields, set at create time, never reused.
  - `invoke(req)` posts `{ payload, operationId, requestId, handlerTimeoutMs }` to **Worker A's** URL only (the gateway is the public surface). **`waiterTimeoutMs` is host-local and is NEVER forwarded** — Worker A enforces only `handlerTimeoutMs` (= `profile.resources.timeoutMs`, capped at 10s for reclaim-safety). The host's `invoke()` enforces `waiterTimeoutMs` (default 30s, ≤ 30s cap) on its own side via a local `setTimeout`/`AbortController`. The wire payload field is named `handlerTimeoutMs` (not `timeoutMs`) precisely so an implementer cannot accidentally forward `waiterTimeoutMs` and have Worker A start enforcing the wrong budget — which would break the takeover/lease budgeting math the dedupe protocol depends on. The full forwarding rules live in the host-vs-remote field-handling table below. Worker A internally invokes Worker B via Service Binding (CF) or signed inter-deployment fetch (Vercel). The host adapter never talks directly to Worker B.
  - No `exec`, `spawn`, `readFile`, or `writeFile` methods exist on the type. Direct callers cannot accidentally invoke them — TypeScript catches at compile time.
  - `destroy()` → issues DELETE for **both** Worker A and Worker B atomically (under the instance mutex). Idempotent (404 on re-destroy is success). Both DELETEs must succeed for `DestroyOutcome.kind === "destroyed-clean"`; if either fails, the outcome is `leaked` or `uncertain` and `providerArtifact` reports BOTH names so the orphan ledger and any downstream remediation can target both.

#### Stateless contract — `create()` is fail-closed for unsupported profile shapes

The `EdgeFunctionInstance` surface (just `invoke` + `destroy`) is intentionally smaller than `SandboxInstance`, so most contract-mismatch issues vanish at the type level. Two checks remain at runtime:

- **Profile structural reject:** the profile mapping table (next section) rejects `filesystem.allowRead`/`filesystem.allowWrite` non-empty, `nexusMounts` non-empty, and `defaultReadAccess: "open"` before any remote call. A profile asking for filesystem-RW is refused at `create()`.
- **Capability requirement reject:** the existing `AdapterCapability` taxonomy in `@koi/core` (`exec`, `spawn`, `copy-files`, `filesystem-rw`, `persistence`, `network`) describes process-level operations. Edge adapters do NOT implement any of these — `invoke(payload)` is a different shape entirely. Therefore `SUPPORTED = Set()` (empty) for these adapters. `create()` rejects any non-empty `profile.required` with `KoiError { code: "UNSUPPORTED_PROFILE", required, supported: [] }`. A caller wanting edge invocation does not populate `profile.required` — they construct the adapter directly and call `invoke()`.
- **Future taxonomy:** when a `sandbox-edge-router` package lands, it will introduce a parallel `EdgeCapability` taxonomy (e.g., `"json-invoke"`, `"streaming-invoke"`) that adapters declare independently. That namespace is intentionally separate from `AdapterCapability` so routers cannot accidentally match a process-level requirement to an edge-invoke implementation. Out of scope here.
- **No streaming:** `EdgeInvokeRequest` does not have `onStdout`/`onStderr` fields, so streaming output cannot be requested. Callers wanting streaming use a different adapter. (The narrower contract eliminates the previous round's "fail at exec but pass at create" concern.)
- A future PR can add a `sandbox-cloudflare-kv` package that backs files with KV/Durable Objects; that is out of scope here and explicitly listed in "Out of scope" below.

#### Per-instance `invoke()` concurrency (serialized) and preemptive destroy

The instance's deployed worker is a shared remote resource. If a caller fires two `invoke()` calls concurrently and the first times out → poisons the instance, the second is already in flight against an instance the host now considers terminal, with possibly-overlapping side effects on the same provider artifact. Worse, `destroy()` could race against an in-flight `invoke`.

To avoid this entire class of hazard, **`invoke()` is serialized per instance**:

- Each instance owns an internal FIFO mutex. Every `invoke()` awaits the mutex, runs to completion (or timeout / abort), then releases.
- Concurrent callers see fair FIFO ordering, not provider-side races.
- A timeout on call N transitions the instance to POISONED before the mutex is released; subsequent queued calls (N+1, N+2, ...) all reject immediately with `POISONED` when they acquire it. They never reach the provider.

**`destroy()` is preemptive, not queued — but does NOT prove remote quiescence:**

- Every `invoke()` is wrapped in a host-side `AbortController`. When `destroy()` is called, it (a) sets the instance state to `DESTROYING`, (b) immediately calls `abort()` on the in-flight invoke's controller (this rejects the caller's `invoke()` promise with `KoiError { code: "DESTROYED" }` and tears down the local `fetch` regardless of whether the remote response ever arrives), (c) drains and rejects all queued invokes with `KoiError { code: "DESTROYED" }`, then (d) issues the DELETE.
- **Mandatory host-side timeout:** `invoke()` enforces a non-optional default `timeoutMs` of 30_000 — this is the WAITER timeout (how long a host caller waits for a response, including any reclaim-takeover delay). It is distinct from the HANDLER budget which is capped at 10_000 ms by `resources.timeoutMs` (see profile-validation table). The 30s host timeout decomposes as: 15s lease + 1s poll + 1s reclaim RTT + 1s second-invoke RTT + 10s handler + 1s commit RTT + 1s safety margin. This accounts for realistic control-plane latency on both reclaim and commit paths. The caller cannot opt out of the host timeout.

**Honest contract — `destroy()` returns `DestroyOutcome`, not bare `void`:**

Cloudflare and Vercel offer no authoritative provider-side per-invocation kill confirmation. DELETE removes routing for new requests but cannot prove an already-running invocation has stopped. We refuse to lie about that:

```ts
export type DestroyOutcome =
  | { readonly kind: "destroyed-clean" }                          // local + remote DELETE confirmed; no in-flight invoke at start
  | { readonly kind: "destroyed-local-remote-indeterminate"; readonly inflightCount: number; readonly priorTimeoutOrAbort: boolean }
  | { readonly kind: "destroyed-local-remote-leaked"; readonly providerArtifacts: readonly string[]; readonly cause: KoiError }
  | { readonly kind: "destroyed-local-remote-uncertain"; readonly providerArtifacts: readonly string[]; readonly cause: KoiError };

// EdgeFunctionInstance.destroy returns Result so the contract surfaces failures explicitly:
readonly destroy: () => Promise<Result<DestroyOutcome, KoiError>>;
```

- `destroyed-clean`: no `invoke()` was in flight when `destroy()` was called, **AND no prior `invoke()` on this instance ever entered TIMEOUT, ABORT, or POISON state at any point in the instance's lifetime**, AND remote DELETE returned 200/204 (or 404 confirmed by follow-up GET). Local handle gone, no possible residual side effects. Once an instance has any timeout/abort/poison event, `destroyed-clean` is **never** returned for that instance — the instance carries a sticky `remoteWorkPossiblyLive: true` flag that downgrades subsequent `destroy()` results to `destroyed-local-remote-indeterminate` automatically. This closes the dishonest case where a prior timeout's remote work could still be running at destroy time even with no current invoke in flight.
- `destroyed-local-remote-indeterminate`: at least one `invoke()` was active when destroy fired, OR a prior `invoke()` had timed out/aborted/poisoned (sticky `remoteWorkPossiblyLive` flag); remote DELETE confirmed but in-flight remote work may still complete. The outcome's payload includes both `inflightCount` (current concurrent invokes) and `priorTimeoutOrAbort: boolean` (whether the sticky flag was the trigger).
- `destroyed-local-remote-leaked`: at least one of the two paired DELETEs (Worker A or Worker B) returned a definitive failure status. The local handle is gone, but at least one provider artifact is **known to still exist**. The list of leaked artifact identifiers is in `providerArtifacts: readonly string[]` (always carries both names if both leaked, the leaked one if only one failed). **Write-before-return invariant:** orphan rows for ALL leaked artifacts are persisted to the SQLite ledger with `synchronous=FULL` and `wal_checkpoint(FULL)` BEFORE this outcome is returned. If the ledger write itself fails, `destroy()` returns `Result.err(KoiError { code: "ORPHAN_LEDGER_WRITE_FAILED" })` instead of a `DestroyOutcome`, mirroring the create-failure path.
- `destroyed-local-remote-uncertain`: at least one DELETE call timed out or errored before any response. Whether the artifacts exist is unknown. Same write-before-return invariant; `providerArtifacts` lists every artifact whose state is uncertain.

**Crash-recovery test (mandatory):** `__tests__/destroy-leak-crash.test.ts` simulates a hard crash by spawning a subprocess that calls `destroy()` against a stub provider returning a 5xx for both paired artifacts, blocks just before return, then is killed with `SIGKILL`. The parent reopens the database and asserts BOTH orphan rows are present (one per artifact in the pair). CI runs this on every PR that touches the destroy path.
- `Result.err`: the destroy attempt itself failed before any cleanup could be attempted (e.g., the local mutex was poisoned by a prior bug). This is the only path where the local handle MIGHT still be holding state. Documented as "should not happen in normal operation"; if observed, the instance is in an inconsistent state and the caller should log and exit.

Callers MUST read the result:
- `Result.err` → unrecoverable instance bug; log + escalate.
- `destroyed-clean` → fully safe to discard. Only achievable when the instance has had no in-flight invoke at destroy time AND no prior timeout/abort/poison anywhere in its lifetime.
- `destroyed-local-remote-indeterminate` → safe to discard local handle; downstream side effects may still arrive (idempotency at side-effect targets handles this).
- `destroyed-local-remote-leaked` / `uncertain` → log every entry in `providerArtifacts` for operator visibility; orphan rows are in the ledger for each. Optionally `await` the next reconciliation pass to confirm cleanup.
- The threat model is updated accordingly: "destroy reliably terminates locally; remote completion of in-flight work is not preventable on these providers and callers must design `invoke()` payloads to be idempotent or carry a unique request token the caller can deduplicate at side-effect targets".

Caller-visible: `invoke()` is awaited as usual; the only behavioral change vs. an OS sandbox is that calls are not parallel within an instance. Callers that need parallelism create multiple instances. Calling `destroy()` while an `invoke()` is in flight rejects that invoke promptly — destroy is never blocked behind hung remote work — and the returned `DestroyOutcome` documents whether residual remote effects are possible.

This is documented prominently in `docs/L2/sandbox-cloudflare.md` and tested in unit suites (concurrent-invoke serialization, poison-after-timeout-rejects-queued, destroy-cancels-queued).

#### `EdgeInvokeRequest` field handling

`EdgeInvokeRequest` is intentionally minimal:

| Field | Disposition | Notes |
|-------|-------------|-------|
| `payload` | mapped | JSON-serialized into POST body as `body.payload`. |
| `operationId` | mapped (mandatory) | JSON-serialized as `body.operationId` AND set as `X-Koi-Operation-Id` request header. Forwarded to the deployed handler in both forms — the handler reads from either. **`operationId` is the authoritative durable-dedupe key consulted by Worker A's shim before invoking the handler** (Cloudflare DO / Vercel KV keyed on `${ownerId}:${operationId}`). It is also the key the operator's handler MUST use for downstream idempotency (defense-in-depth). |
| `requestId` | mapped (mandatory) | JSON-serialized as `body.requestId` AND set as `X-Koi-Request-Id` request header. **`requestId` is per-attempt only**: it scopes the per-isolate in-memory cache that collapses two concurrent fetches with the same `requestId` into one handler call (a same-isolate same-attempt optimization, NOT a cross-attempt or cross-instance dedupe mechanism). The handler MAY observe `requestId` for tracing but MUST NOT use it as a dedupe key — the durable `operationId`-keyed store is the only authoritative dedupe. |
| `waiterTimeoutMs` | host-enforced ONLY (not forwarded) | Used for the host `AbortController` to bound how long `invoke()` blocks. Defaults to and is capped at 30_000 ms. **Not** sent in body and **not** capped by `profile.resources.timeoutMs`. |
| (handler budget — `profile.resources.timeoutMs`) | mapped to body | Passed in body as `body.handlerTimeoutMs` and enforced inside Worker A's shim as the deadline for the handler call. Capped at 10_000 ms (see profile-validation table). The shim, NOT the host, enforces this. |
| `signal` (`AbortSignal`) | bridged-locally + remote-cancel | (a) Local: abort the host `fetch` so the caller's promise rejects on schedule. (b) Remote: when signal fires OR `waiterTimeoutMs` elapses, fire-and-forget POST to `/cancel` with `requestId` so the shim can correlate. The shim implements `/cancel` by aborting in-flight work it controls. |

`operationId` and `requestId` are sent as both body fields and headers for redundancy: middleware logging captures the headers without parsing JSON, and the shim's dedupe path reads the header without parsing the body. Both fields are validated as non-empty UUID-like strings before send; missing fields cause `KoiError { code: "MISSING_OPERATION_ID" | "MISSING_REQUEST_ID" }` before any fetch.

The shim's deployed-handler invocation is `handler({ payload, operationId, requestId })`. The handler signature is documented in `docs/L2/sandbox-cloudflare.md` so deployers know which key to use for downstream dedupe (`operationId` only).

There is no `onStdout`/`onStderr` on `EdgeInvokeRequest` — streaming is not part of the contract, by design. Callers who need streaming use a different adapter.

#### Two-tier idempotency (`operationId` for downstream, `requestId` for shim cache)

The contract distinguishes two distinct idempotency scopes — they are NOT the same key:

| Field | Lifetime | Owner | Purpose |
|-------|----------|-------|---------|
| `operationId` | Full logical operation, **persists across `destroy()` + new `create()` + multiple instances** | Caller (NEVER auto-generated) | **Authoritative dedupe key at every layer:** (a) Worker A's durable store (Cloudflare DO / Vercel KV) keyed on `${ownerId}:${operationId}` is consulted BEFORE invoking the handler; (b) the operator's deployed handler uses it as downstream idempotency key as defense-in-depth. Cross-instance retries (after `destroy()` + new `create()`) hit the same DO id / KV key and observe the prior outcome. **`operationId` is NOT shim-ignored** — earlier draft language stating that has been removed. |
| `requestId` | Single network attempt only — generate fresh on every retry | Caller (per-attempt; e.g., `crypto.randomUUID()` per `invoke()` call) | Per-isolate in-memory cache key for the same-isolate same-attempt deduplication of in-flight calls. NOT a cross-instance mechanism; the durable store keyed on `operationId` handles cross-instance dedupe. `requestId` is forwarded to the handler for tracing/logging only. |

The previous spec passes used `requestId` for both purposes, which collapsed them and contradicted itself across the destroy/recreate boundary. The two-field model resolves this:

- A retry within the SAME instance with the SAME `operationId` and a FRESH `requestId` allows the shim cache to miss (different `requestId`) but downstream dedupe still works (same `operationId`). Caller saves nothing on the shim path but doesn't double-execute external side effects.
- A retry across `destroy()` + new `create()` carries the SAME `operationId` and a FRESH `requestId`. The shim cache is empty in the new instance but downstream dedupe still works. This is the recovery path the previous spec broke.
- A caller running multiple parallel attempts of the same operation (e.g., racing two instances) uses the same `operationId` for both — only one of their downstream effects commits.

#### Request-ID shim cache (best-effort dedupe — NOT exactly-once)

Because `destroy()` and timeout/abort can leave remote work in flight (see `DestroyOutcome`), **`requestId` is required, not optional, on every `invoke()`**. The shim deduplicates by ID — but with explicit honest limits:

- **The dedupe is a best-effort cache, not an exactly-once guarantee.** The shim caches `(operationId, requestId) → { status, result, expiresAt }` in a per-isolate in-memory `Map` keyed on the **composite** of both fields. Cloudflare and Vercel do not pin retries to the same isolate; isolates can also be evicted at any time. Therefore a retry can land on a fresh isolate where the dedupe entry does not exist, and the handler runs again.
- **Contract claim:** the adapter does NOT promise exactly-once execution. The contract is "if the retry lands on the same warm isolate within the cache window, dedupe takes effect; otherwise the handler may run twice." This is documented at the top of `docs/L2/sandbox-cloudflare.md` and `sandbox-vercel.md` so callers cannot mistake the mechanism for a stronger guarantee.
- **Supported workload class for v1 is RESTRICTED to side-effect-free handlers (workloadClass: "A").** The earlier draft offered a Workload Class B (operator-allowed outbound side effects mediated by koi wrappers + a `globalThis.fetch` fence + AST lint allowlist). That class is **DEFERRED to a future PR** because the residual bypass surface (dynamic-`import()`, pre-init `fetch` capture, third-party libraries that resolve their own globals) cannot be mechanically closed on Cloudflare Workers / Vercel Functions today. Rather than ship "best-effort under partial-failure" as a default, v1 admits only handlers whose duplicate execution is intrinsically harmless:
  - **Workload class A (the only supported class for v1):** handler is purely a function of `payload`. No outbound `fetch`, no DB writes, no message-queue publishes, no filesystem writes. Pure compute or read-only data shaping. **Construction rejects** handlers that do not declare `workloadClass: "A"` with `KoiError { code: "WORKLOAD_CLASS_NOT_SUPPORTED", message: "Only workloadClass:\"A\" (side-effect-free) is supported in this release. Class B (mediated outbound) is deferred." }`.
  - **Runtime fence is the primary enforcement; the AST scan is belt-and-braces. The fence applies to OPERATOR-VISIBLE globals only — koi-shim-private network capability is captured BEFORE the fence is installed.** The shim is itself the component that performs Worker B's per-request side effects (signature verification, nonce KV `SET NX`, telemetry), so the shim necessarily needs network access. The bootstrap sequence is: (1) at module top level, the shim captures the unstubbed `fetch` into a closure-private local: `const _shimFetch = globalThis.fetch.bind(globalThis);` (this reference is never exposed to operator code); (2) the shim then installs throwing stubs on `globalThis.fetch`/etc. via `Object.defineProperty`; (3) only after the fence is installed does the shim defer-load the operator handler. From that moment forward, operator code that reads `globalThis.fetch` sees a throwing stub. The shim's nonce-burn KV write uses `_shimFetch(...)` — which is unreachable from operator code because (a) it is a const-bound local in the shim module's closure, (b) ES module bindings cannot be enumerated or mutated from outside the module, and (c) the shim does not export it. **Adversarial test (mandatory):** `__tests__/class-a-shim-fetch-not-leaked.test.ts` deploys a class-A handler that attempts to read every documented escape (`globalThis.fetch`, every property of imported modules, `Reflect.ownKeys` over the realm, etc.) and asserts none of them produce a working fetch reference; the shim's nonce-burn KV path still functions in the SAME test (proving the shim retains its private network capability). Worker B's bootstrap shim, BEFORE importing the operator handler module, replaces ALL outbound-network and nested-execution-context global symbols on `globalThis` with throwing stubs. The complete fence list (none configurable, none writable):
    - `globalThis.fetch = () => { throw new Error("FETCH_FORBIDDEN_CLASS_A"); }`
    - `globalThis.XMLHttpRequest = class { constructor() { throw new Error("XHR_FORBIDDEN_CLASS_A"); } }`
    - `globalThis.WebSocket = class { constructor() { throw new Error("WS_FORBIDDEN_CLASS_A"); } }`
    - `globalThis.Worker = class { constructor() { throw new Error("NESTED_WORKER_FORBIDDEN_CLASS_A"); } }` — closes the previous "honest residual" where a third-party library that called `new Worker(...)` could spawn a nested execution context with fresh, unstubbed `globalThis.fetch`. With `Worker` itself stubbed, no nested context is reachable from operator code.
    - `globalThis.SharedWorker = class { constructor() { throw new Error("NESTED_SHARED_WORKER_FORBIDDEN_CLASS_A"); } }` — same rationale.
    - `globalThis.MessageChannel = class { constructor() { throw new Error("MESSAGE_CHANNEL_FORBIDDEN_CLASS_A"); } }` — defense-in-depth; MessageChannel alone cannot reach the network, but cutting it off prevents handlers from coordinating with whatever-they-spawn against future runtime exposes.
    - `globalThis.WebAssembly.instantiate` and `globalThis.WebAssembly.instantiateStreaming` are wrapped to reject any module whose imports include host functions other than the small audited set (typed-utility math/memory only — NO `env.fetch`, NO `wasi_snapshot_preview1`). WASI exposure would be a fresh path to outbound effects.
    - **`globalThis.caches` (Cloudflare Cache API) is fenced.** `globalThis.caches = { default: { put: throws, delete: throws, match: throws }, open: throws }` — operator code that calls `caches.default.put(...)` / `caches.open(...)` hits a throwing stub. CF Workers' Cache API is a write-capable side-effect path even with `network.allow=false`; under retry paths it would let a duplicate-executed handler mutate edge cache state. AST scan additionally rejects `caches.` and `caches[` accesses in operator code. Adversarial test (mandatory): `__tests__/class-a-runtime-cache-fence.test.ts` smuggles a `caches.default.put(req, res)` past the AST lint and asserts the runtime stub throws.
    - **`globalThis.crypto.randomUUID` and timing-sensitive APIs that read host clocks (`Date.now`, `performance.now`) remain available** — they are read-only and side-effect-free. Documented for completeness so future PRs do not over-fence.
    - **Provider-native mutable globals catalogue.** A package-private file `src/runtime-fence-targets.ts` lists every globalThis property documented as mutable on CF Workers and Vercel Edge runtimes, marked `fenced` or `read-only-allowed`. CI gate `__tests__/runtime-fence-target-coverage.test.ts` snapshot-tests this file against the upstream `@cloudflare/workers-types` and `@vercel/edge` type definitions: any new mutable global appearing upstream that is not categorized here fails CI. This is how the fence stays current as providers add APIs (e.g., a future `globalThis.email.send` or `globalThis.queues.send` would be caught by this gate).
    Together with the existing fetch/XHR/WebSocket fences, these stubs cover every documented outbound or nested-context primitive on CF Workers and Vercel Edge. Operator code that tries any of them — directly, via library, via dynamic property access, via captured reference taken AFTER shim init — hits a throwing stub and the handler invocation surfaces a transient handler error to Worker A. The handler cannot establish outbound network and cannot escape the current isolate's stubbed globals. **This is a real mechanical fence**, not just static analysis. Adversarial tests (mandatory): `__tests__/class-a-runtime-fetch-fence.test.ts` (smuggle a `fetch("https://example.com")` call past the AST lint and assert it throws), `__tests__/class-a-runtime-nested-worker-fence.test.ts` (smuggle `new Worker(blobUrl)` and assert it throws), `__tests__/class-a-runtime-wasi-fence.test.ts` (attempt `WebAssembly.instantiate` with `wasi_snapshot_preview1` imports and assert rejection).
  - **Pre-init capture is closed by deploy-time bootstrap-position invariant.** A handler that captures `globalThis.fetch` BEFORE the shim's stub install would still have a working reference. The shim init runs as the FIRST top-level statement in the bundle's entry module and uses `Object.defineProperty(globalThis, "fetch", { value: throwingStub, configurable: false, writable: false })` to make subsequent reassignment impossible. The CI gate (`__tests__/bootstrap-shim-no-top-level-handler-eval.test.ts` from step 1) already asserts no operator code runs at top level before shim init — so there is no execution window in which the operator could capture the original `fetch`.
  - **AST scan is belt-and-braces (deploy-blocking), recursive over the FULL operator-authored module graph, and applies to OPERATOR code only.** `createCloudflareAdapter().create(config)` walks the bundle's module-resolution graph starting at the operator entry module and recursively scans EVERY operator-authored module reachable via static `import` declarations or static-specifier `import()` calls. Third-party allowlisted dependencies (`zod`, `valibot`, `date-fns`) are NOT recursed into (their bytes ship as bundled vendor code under the audited allowlist); operator-authored code IS recursed into without exception. **Top-level purity is enforced on EVERY operator-authored module in the graph**, not just the entry: each module's top level must contain only `import` declarations, `export` declarations, and pure const/function/class declarations whose initializers do not call functions, do not access stubbed/forbidden globals, and do not invoke side effects. Side-effectful top-level (IIFEs, top-level await of expressions, expression statements that call functions) anywhere in the graph causes `WORKLOAD_CLASS_A_VIOLATION` with the offending file path AND line number reported. The scan flags ANY of `fetch(`, `XMLHttpRequest`, `WebSocket`, `new Worker`, `new SharedWorker`, `new MessageChannel`, `WebAssembly.instantiate(`, `WebAssembly.instantiateStreaming(`, `caches.`, `caches[`, common DB-client constructors, known queue producers, `globalThis[*]` dynamic property access, `new Function(`, dynamic `import(${nonStaticString})` (template/concat/variable arguments — static string literals are accepted), and any third-party dependency not on the small audited allowlist. Adversarial test (mandatory): `__tests__/class-a-ast-recursive.test.ts` constructs an entry handler whose top level is pristine but which imports a helper module that runs `caches.default.put(...)` at top level; asserts construction rejects with `WORKLOAD_CLASS_A_VIOLATION` citing the helper file path. Any finding causes `create()` to reject with `KoiError { code: "WORKLOAD_CLASS_A_VIOLATION", findings: [...] }`. The koi-owned bootstrap shim is EXEMPT from the scan — it is a fixed koi-authored artifact whose bytes are content-hash-locked against `bootstrap-shim.lock.json` and whose single `await import("./handler.js")` uses a static string specifier the scan would accept anyway. This two-tier policy is explicit in the spec to prevent the prior contradiction where the shim's loader looked like exactly the bypass primitive the scan rejects in operator code.
  - **Closed (was previously listed as "honest residual"):** the prior draft acknowledged that `new Worker(...)` could spawn a nested context with fresh `globalThis.fetch`. That escape is now mechanically closed by stubbing `globalThis.Worker`, `globalThis.SharedWorker`, and `globalThis.MessageChannel` themselves alongside the network globals — handler code cannot construct any of them. The AST scan additionally rejects `new Worker`/`new SharedWorker`/`new MessageChannel` syntax in operator code so library transitive uses are caught at deploy time. **There is no documented path on CF Workers or Vercel Edge that allows operator-visible outbound network from a class-A handler without going through one of the stubbed globals.** The shim's closure-private `_shimFetch` is shim-only and not operator-visible.
  - **Workload class B (mediated outbound) is documented as future work** with the runtime-fetch fence + AST allowlist design preserved in this spec for the future PR. It does not ship in v1. Any caller that needs outbound side effects from the handler MUST move that side effect outside the handler — e.g., the handler returns a description of what to do, and the caller (a trusted host-side process) actually performs the outbound write with proper idempotency. This pushes the duplicate-execution risk to a code path the host owns, where it can be properly fenced.
  - **Workload class C (anything else) is REJECTED** at construction.

  With class A as the only supported class, the documented re-execution paths (`DEDUPE_PERSISTENCE_FAILED`, `LEASE_LOST`, `OWNERSHIP_LOST`, oversized-result) cannot cause duplicate external side effects — there ARE no external side effects in the handler. Re-execution is safe by construction. The dedupe store still mechanically handles the happy path; the partial-failure paths still re-run, but re-running a pure function is harmless. **This is what makes the v1 contract honest:** the durable dedupe is mechanical for caching success/failure outcomes, AND duplicate execution risk is eliminated by restricting the workload class rather than by trusting operator discipline.

  Several documented failure paths still allow the handler to be re-run before the operation is durably retried — **all harmless under class A** because a class-A handler has no side effects to duplicate:
  - Cloudflare DO `complete` retry exhaustion (`DEDUPE_PERSISTENCE_FAILED` after 3 attempts).
  - Vercel KV lease loss mid-handler (`LEASE_LOST`) and ownership loss at commit (`OWNERSHIP_LOST`).
  - Oversized success result is now closed by writing a permanent `RESULT_TOO_LARGE_PERMANENT` failed-permanent terminal record (see Vercel section).

  **The deferred class-B subsystem (NOT in v1) is described elsewhere with its own attestation/wrapper/lint posture.** Class B will reintroduce `assertIdempotent`, the koi.fetchWithIdempotencyKey wrappers, the runtime fetch fence, and the deploy-blocking AST allowlist. Until class B ships, **none of those mechanisms exist in v1's adapter**: there is no `assertIdempotent` flag, no `koi.fetchWith*` wrappers in the runtime, no failOnRawSideEffect knob. The only enforcement is the create-time AST scan that rejects ANY side-effect-shaped construct, and re-execution is safe because there are no side effects to duplicate. The earlier draft's references to wrappers being "provided but optional" are ARTIFACTS of the class-B design that has been deferred — they do not describe v1 behavior.

  - **`requestId` MUST NOT be used for any dedupe purpose** — neither the durable store nor the downstream target should key on it.
- The shim caches entries for **300 seconds** after the original invocation completes (or fails). Expiration is wall-clock; entries are pruned lazily on each invoke.
- On `POST /invoke` arrival, the shim looks up the composite key `(operationId, requestId)`:
  - **Unknown composite key:** execute the handler, store result keyed on `(operationId, requestId)`, return it.
  - **Known composite key, in-flight:** the second request awaits the first's outcome (same Promise) and returns the same response. Two callers using the SAME `(operationId, requestId)` pair see the same result; the handler runs exactly once.
  - **Known composite key, completed:** return the cached result without re-running the handler.
  - **`requestId` reused with a DIFFERENT `operationId`:** treated as a fresh, unrelated invocation. The shim does NOT alias the new request to the cached entry — the lookup misses because the composite key differs. This prevents a caller bug (accidentally regenerating `operationId` while reusing a stale `requestId`, or vice versa) from returning one operation's result to a different operation. Defense-in-depth against caller misuse.
- **`requestId` is mandatory at the API boundary — no implicit generation, and is FRESH per attempt (NEVER reused on retry).** The host-side `invoke()` rejects requests without `requestId` with `KoiError { code: "MISSING_REQUEST_ID" }` before any fetch. There is no auto-gen path. **Authoritative retry contract: `operationId` is the stable durable-dedupe key reused across all retries of the same logical operation; `requestId` is FRESH per attempt and MUST NOT be reused.** The reason for requiring caller-supplied `requestId` (vs. auto-generation) is observability and traceability — caller code owns the per-attempt id so it can be correlated with caller-side logs, NOT to enable retry reuse. Earlier draft language suggesting `requestId` reuse on retry was incorrect and has been removed; reuse would alias distinct attempts onto a single shim-cache entry and is forbidden. The only authoritative cross-retry dedupe key is `operationId` consulted against the durable Cloudflare-DO/Vercel-KV store.
- Required caller pattern: callers supply a stable `operationId` ONCE per logical operation (and pass it through any subsequent recovery boundaries), and a FRESH `requestId` per network attempt:
  ```ts
  const operationId = crypto.randomUUID();   // owned by the caller; persists across destroy/recreate
  for (let attempt = 0; attempt < 3; attempt++) {
    const requestId = crypto.randomUUID();   // fresh per attempt; identifies this network call
    const r = await instance.invoke({ payload, operationId, requestId });
    if (r.ok) return r.value;
    if (r.error.code !== "TIMEOUT" && r.error.code !== "POISONED") throw r.error;
    // POISONED → caller may destroy + recreate, then retry with the SAME operationId
    if (r.error.code === "POISONED") {
      await instance.destroy();
      instance = await adapter.create(...).then(unwrap);
    }
  }
  ```
  The deployed handler reads `operationId` from the wire payload and uses it as the idempotency key for any downstream side effect — e.g., as `Idempotency-Key` header on Stripe calls, or as a primary key on an event-log table. The shim's `requestId` cache is invisible to the handler.
  Frameworks built on top of the adapter (retry wrappers, higher-level helpers) are responsible for retaining `operationId` for the operation's lifetime — they MUST NOT regenerate it on retry. The two-field model means there is exactly one canonical answer to "which key does what": `operationId` for correctness, `requestId` for performance.
- **Cross-instance retries (after `destroy()` + new `create()`) ARE deduped by the durable store.** The Cloudflare DO and Vercel KV stores live at the fleet level (per `ownerId`), not per-instance, so a fresh `create()` after `destroy()` produces a new pair of Worker A/Worker B but they STILL bind to the same DO namespace / KV instance. When the new Worker A receives the retried `invoke({ operationId, requestId: <new> })`, it consults the same `${ownerId}:result:${operationId}` key as the old instance and observes the prior outcome. **This is the primary cross-retry safety mechanism**, exactly as defined in the dedupe sections above. The earlier statement that "cross-instance retries cannot benefit from shim dedupe" is true only of the per-isolate `requestId` Map — the durable store is fleet-wide and does work across instance boundaries. Downstream idempotency is the residual safety net for the documented persistence-failure paths (DEDUPE_PERSISTENCE_FAILED, LEASE_LOST, OWNERSHIP_LOST, RESULT_TOO_LARGE), not the primary mechanism.
- The shim's per-isolate `requestId` cache is bounded: max 1000 entries with LRU eviction. This is a performance optimization for same-isolate retries within 300s only; the durable store handles cross-isolate and cross-instance correctness.
- Caller-visible (single source of truth): **`operationId` is the logical-operation key, owned and retained by the caller for the full lifetime of the operation including across `destroy()`/`create()` boundaries; `requestId` is per-attempt and ephemeral.** The SDK does NOT auto-generate either field. Wrappers that hide id generation MUST persist `operationId` in their own state for the operation's lifetime. Documented prominently in `docs/L2/sandbox-cloudflare.md`.

#### Cancellation honesty (always-poison on timeout)

Cloudflare Workers cannot guarantee preemption of arbitrary user code, and a 200 from `/cancel` proves only that the shim accepted the cancel — not that the running command stopped. We therefore treat **any local abort or timeout as terminal for the instance**, regardless of `/cancel` response:

- Local abort fires on schedule — caller's promise rejects with `TIMEOUT`.
- The instance immediately enters **POISONED** state. Subsequent `invoke` calls fail-closed with `KoiError { code: "POISONED" }`. The only valid operation is `destroy()`.
- The instance optionally fires a best-effort `/cancel` POST as a courtesy to free provider resources sooner, but the result is ignored — poisoning is not contingent on it.
- `destroy()` on a poisoned instance proceeds normally (DELETE script). Caller must `create()` a fresh instance for any further work.

Rationale: the only way to be sure a remote command has stopped is to delete the artifact running it. Until then, side-effect overlap is possible. We do not gamble on `/cancel` ack semantics.

The only path to skip poisoning would be an authoritative provider-side per-command termination ack (e.g., a kill-by-id confirmation Cloudflare does not currently offer). If that capability lands, the contract can be relaxed; until then, poison-on-timeout is unconditional.
- **Concurrency safety:** the adapter does not maintain a shared mutable resource; each instance is fully independent. No lease/refcount needed because there is no shared state.
- Worker shim is a small string template colocated in `client.ts` (the JS that runs inside CF Workers and accepts the protocol). Kept ≤80 LOC.

#### `SandboxProfile` enforcement (fail-closed, against real core shape)

Mapping is built against the actual fields in `packages/kernel/core/src/sandbox-profile.ts` (`FilesystemPolicy`, `NetworkPolicy`, `ResourceLimits`, `env`, `nexusMounts`, `required`, `ssh`). Every field has a defined disposition; defaults are fail-closed.

| Profile field | Cloudflare disposition | Reason |
|---------------|------------------------|--------|
| `filesystem.defaultReadAccess` | accept iff `"closed"`; **REJECT** `"open"` | Workers have no host filesystem — `closed` is trivially satisfied. `open` cannot be honored (there is no host FS to open) so refuse rather than silently lie. |
| `filesystem.allowRead` (any) | **REJECT** `UNSUPPORTED_PROFILE field=filesystem.allowRead` | No host FS → cannot grant read access to host paths. |
| `filesystem.denyRead` (any) | accept (vacuously satisfied) | No host FS → no reads possible. |
| `filesystem.allowWrite` (any) | REJECT | Same as allowRead. |
| `filesystem.denyWrite` (any) | accept (vacuously satisfied) | Same as denyRead. |
| `network.allow = true` | **REJECT** | Class A is side-effect-free. Outbound network is forbidden by contract. The runtime cannot mechanically prevent a handler from calling `fetch`, but the profile rejects any operator request that explicitly opts in to outbound network — making `allow = true` a deploy-time error rather than a permitted-but-attested mode. Combined with the deploy-blocking AST lint, this is a contract-level fence: a class-A handler that needs outbound network has misclassified the workload and the create call refuses. |
| `network.allow = false` | accept (REQUIRED) | The only valid value for class A. Documents intent at the contract boundary; the AST lint enforces it on the source side. |
| `env` (non-empty) | **REJECT** | Class A handlers are pure functions of `payload`. Operator secrets in `env` are only justified for handlers that perform outbound side effects, which class A forbids. Construction rejects non-empty `env` with `KoiError { code: "ENV_FORBIDDEN_FOR_CLASS_A" }`. This shrinks the blast radius of any Worker B exposure to zero operator credentials. |
| `resources.maxMemoryMb` | accept iff `<= 128` | CF Workers cap. Reject above. |
| `resources.timeoutMs` | accept iff `<= 10_000` | **Reclaim-safe handler budget with explicit network/commit slack**, NOT the raw CF Workers Unbound CPU limit (30_000). Budget breakdown of the 30s host invoke timeout: 15s claim-lease TTL (worst-case wait until a crashed owner's lease expires) + 1s polling tick (loser observes expiry) + ~1s reclaim Lua RTT + ~1s second-invoke handshake/RTT + 10s handler budget + ~1s commit RTT + ~1s safety margin = 30s total. Profiles requesting more than 10_000 ms are rejected with `KoiError { code: "TIMEOUT_EXCEEDS_RECLAIM_BUDGET" }` because under realistic network latency the reclaim protocol cannot complete the operation inside the host invoke window — the failure mode would be host-side TIMEOUTs surfacing while the prior attempt may still commit side effects. The earlier 14_000 ms cap consumed the entire window with no slack and was unsafe under normal control-plane latency. Operators who need longer end-to-end deadlines split the work into multiple `invoke()` calls each within the 10s budget. The cap is documented in `docs/L2/sandbox-cloudflare.md` and `sandbox-vercel.md`. |
| `resources.maxPids` | accept iff `=== 1` or omitted | Workers run a single isolate; multi-process not available. Reject `> 1`. |
| `resources.maxOpenFiles` | accept (vacuously) | No host FDs in Workers. |
| `env` (non-empty) | **REJECT** | Class A is the only supported workload class in v1; class A handlers are pure functions of `payload` and have no use for operator secrets. Construction rejects with `KoiError { code: "ENV_FORBIDDEN_FOR_CLASS_A" }`. The earlier "mapped — forwarded as Worker secrets" rule is REMOVED; only koi-managed internal secrets (`KOI_PAIR_VERIFY_KEY`, `KOI_HANDLER_ARMED` on Worker B; `KOI_INSTANCE_TOKEN`, `KOI_OWNER_ID`, dedupe credentials, `KOI_PAIR_SIGNING_KEY` on Worker A) are uploaded by the create state machine. Any future class-B (mediated outbound) workload will reintroduce a controlled `env` upload path with explicit per-key approval; v1 has no such path. |
| `env` (empty/omitted) | accept | The only valid shape for class A. |
| `nexusMounts` | REJECT | Requires FUSE; not available on edge. |
| `ssh` | **ignore** | Per `SandboxProfile.ssh` doc comment: "Other adapters MUST ignore this field." Treating it as a validation error would break profile portability when a profile carries an SSH stanza for a different backend. |
| `required` (capabilities) | **enforced by adapter** (and additionally by router) | The adapter calls `validateRequiredCapabilities(profile.required, SUPPORTED)` at the top of `create()` and rejects unsupported capabilities with `UNSUPPORTED_PROFILE` before any remote call. The router does the same upstream as a fast-path; the adapter never assumes the router pre-filtered. Single source of safety for direct callers. |
| Unknown future fields | REJECT (default-deny) | TypeScript catches at compile time; runtime exhaustive check guards against type-erasure bugs. |

Vercel applies the same template, but since runtime selection is deferred (see Out of scope) and the adapter always deploys to **Edge**, validation caps are **Edge-only**: `maxMemoryMb <= 128` and `timeoutMs <= 10_000` (the same reclaim-safe budget enforced for Cloudflare — see the CF row above; profiles with `timeoutMs > 10_000` reject with `TIMEOUT_EXCEEDS_RECLAIM_BUDGET` regardless of provider). Serverless caps (3008MB / 900_000ms) are NOT accepted. The reclaim-safe handler-budget cap stays at 10_000 ms regardless of runtime unless the lease/timeout protocol is redesigned with measured slack for the worst-case takeover path.

The mapping lives in `validate.ts` as a pure function `mapProfileToCloudflare(profile): Result<CloudflareDeployConfig, KoiError>`. Adapter `create()` calls it first and short-circuits on error before any fetch. The function uses an exhaustive switch over a discriminated union derived from the profile so adding a new core field without updating this mapper is a TypeScript error.

#### Profile conformance tests + compile-time exhaustiveness

`packages/sandbox/sandbox-conformance` provides a profile-rejection harness. Each cloud package adds a conformance test that walks every documented profile field and asserts the accept/reject behavior above.

Schema-drift detection cannot be runtime-reflective because `SandboxProfile` is a TypeScript interface (erased at runtime). Instead, drift is caught at **compile time** via an exhaustive `satisfies`-keyed const:

```ts
// in @koi/sandbox-cloudflare/src/validate.ts
import type { SandboxProfile } from "@koi/core";

type ProfileFieldDisposition = "accept" | "reject" | "vacuous" | "ignore" | "mapped";

const PROFILE_FIELD_DISPOSITIONS = {
  filesystem: "reject-or-accept-by-subfield",  // handled by inner table
  network: "reject-or-accept-by-subfield",
  resources: "validate-against-edge-caps",
  env: "reject-if-non-empty",  // class A admits only empty env; non-empty rejects with ENV_FORBIDDEN_FOR_CLASS_A
  nexusMounts: "reject",
  required: "validate-empty-only",
  ssh: "ignore",
} as const satisfies Record<keyof SandboxProfile, string>;
```

If a future PR adds a new top-level key to `SandboxProfile` without updating this const, TypeScript fails compilation with `Property '<newField>' is missing in type ...`. The cloud package will not build. This is a hard gate, not a runtime test.

Each subfield (filesystem.*, network.*, resources.*) gets its own `satisfies`-keyed const using `keyof FilesystemPolicy`, `keyof NetworkPolicy`, `keyof ResourceLimits` for the same exhaustiveness guarantee at compile time.

### `@koi/sandbox-vercel` (DESIGN-ONLY for v1; NOT shipped)

**Vercel is design-only in this release.** The package is NOT published, NOT runtime-integrated via `@koi/runtime`, NOT covered by golden-query coverage, NOT a merge gate, and NOT included in the v1 ship contract. Every Vercel section in this spec — provisioning state machine, dedupe protocol, ledger contract, fence model, attestation rules — is preserved as design reference for the future Vercel PR but does NOT participate in any required CI gate for the issue-1377 ship. The release-scope summary at the bottom of this spec is the authoritative answer.

The deferred design (preserved for future implementation):

- Endpoint: `https://api.vercel.com/v13/deployments` (create), `/v13/deployments/{id}` (delete).
- Auth: `vercelToken` + `teamId?` from config.
- Per-instance deployment with immutable per-deployment URL.
- `destroy()` idempotent.
- Same `invoke()`-only wire protocol as the CF shim.

## Sharing strategy

The two cloud adapters share ~150 LOC of pattern (HTTP fetch with timeout, error classify, instance protocol). **Do not extract a shared cloud-base package this PR** — Rule of Three: 2 occurrences = duplicate; revisit when a third edge adapter lands. Keep duplication explicit and obvious; small helper differences (auth header, endpoint shape) make a shared abstraction premature.

## Tests

### Unit (`bun:test`, in CI)

- `validate.test.ts`: every config field — missing token, malformed accountId, invalid script name, etc.
- `classify.test.ts`: every error path → KoiError shape.
- `wasm-executor.test.ts`: real `WebAssembly` modules built inline (e.g., `add(i32,i32)` from a small wat→wasm fixture committed under `__fixtures__/`). Tests: success, trap, OOM, timeout, invalid module bytes.
- `async-executor.test.ts`: same + abort signal, async host imports.
- `module-loader.test.ts`: bytes loader + URL loader (mocked fetch).
- `adapter.test.ts` (cloud): `createXAdapter` returns `Result.ok` on valid config and `Result.err UNAVAILABLE` on probe failure (mocked fetch); `create(profile)` rejects every unsupported `profile.required` capability and every unsupported `profile.filesystem`/`network`/`resources` shape per the mapping table; rejects `WebAssembly.Module` for wasm input (negative).
- `instance.test.ts` (cloud): `invoke` happy path, non-200 → KoiError, timeout via AbortSignal poisons instance, subsequent `invoke` returns `POISONED`, `destroy` deletes script and rejects in-flight invoke with `DESTROYED`, concurrent `invoke` calls serialize FIFO, deployed shim returns 404 for `POST /exec` / `POST /read` / `POST /write` (proving deprecated surface absent).

Coverage threshold: 80% per `bunfig.toml`.

### Integration (env-gated developer harness)

- `__tests__/integration.test.ts` per cloud package: skipped unless `CF_API_TOKEN` / `VERCEL_TOKEN` set. Deploys a real worker/function, invokes once, deletes. Used during local development.

### Provider smoke (mandatory pre-merge gate)

Mocked fetch is insufficient evidence for auth, header shape, endpoint correctness, response parsing, and cleanup. A separate **required** workflow `provider-smoke.yml` runs against shared sandbox accounts (CF + Vercel) on every PR that touches `packages/sandbox/sandbox-cloudflare/**` or `packages/sandbox/sandbox-vercel/**`. It exercises the **safety-critical failure paths**, not just the happy path:

**Lifecycle scenarios:**

1. **happy-path** — create → invoke (hello-world) → destroy (200/204 first call, 404 second, idempotency proven)
2. **mid-create failure** — inject a fault after the deploy step succeeds but before secrets upload (test hook: pass an env var with a forced 4xx-trigger key). Assert the adapter returns `CREATE_FAILED` with `cleanedUp: true`, then list scripts by attempt prefix and assert zero remain.
3. **create timeout** — set `createTimeoutMs: 1` so the create flow times out after deploy initiation. Assert `CREATE_FAILED_INDETERMINATE` is returned with the leaked `scriptName` populated, then a janitor sweep deletes it and the assertion passes.
4. **invoke timeout poisons instance** — create a sandbox whose shim deliberately sleeps longer than `invoke(req.timeoutMs)`. Assert (a) caller's promise rejects with `TIMEOUT`, (b) a subsequent `invoke` call rejects with `POISONED`, (c) `destroy()` succeeds, (d) post-destroy script list shows zero artifacts.
5. **abort-signal poisons instance** — caller passes `AbortSignal` and aborts mid-invoke; same assertions as (4).
6. **leak sweep (final)** — list all scripts/deployments matching `koi-ci-${runId}-*`; fail the job if any remain. This catches escapes from any of the above scenarios that destroy() failed to clean up.

**Configuration:**

- Tokens stored in repo secrets (`CF_CI_API_TOKEN`, `VERCEL_CI_TOKEN`), scoped to a dedicated sandbox account with a billing alarm.
- The workflow blocks merge if any scenario fails — especially the leak sweep and the poison-after-timeout assertion, which are the regressions the design relies on for safety.
- **Fork PRs do NOT skip the gate.** The default GitHub workflow trigger for forks lacks secret access; this is acceptable for the initial CI run but **NOT acceptable as a merge condition**. A separate `provider-smoke-trusted.yml` workflow runs on a maintainer-triggered `workflow_dispatch` event with the same scenarios and full secret access. A maintainer MUST run `provider-smoke-trusted` against the fork's HEAD SHA and the merge is blocked until that workflow has reported success on that exact SHA. The branch protection rule for paths under `packages/sandbox/sandbox-cloudflare/**` and `packages/sandbox/sandbox-vercel/**` requires `provider-smoke-trusted/passed` as a status check. CODEOWNERS approval is necessary but not sufficient.
- A nightly cron runs the same workflow against `main` to catch provider-side drift between merges.

### Golden queries (CI gate per CLAUDE.md)

The wasm and edge packages use **different** golden-query paths because they have different shapes (process-style executor vs invoke-only adapter). The split is the same one introduced by the kernel/runtime integration section above.

| Query | Path | Recording script | Replay test |
|-------|------|------------------|-------------|
| `sandbox-wasm` | Standard sandbox (executor-shaped) | `packages/meta/runtime/scripts/record-cassettes.ts` (existing) | `packages/meta/runtime/src/__tests__/golden-replay.test.ts` (existing) |
| `sandbox-cloudflare` | Edge-specific | `packages/meta/runtime/scripts/record-edge-cassettes.ts` (NEW in PR 2) | `packages/meta/runtime/src/__tests__/golden-edge-replay.test.ts` (NEW in PR 2) |
| `sandbox-vercel` | DEFERRED — design-only, NOT shipped this release | NOT applicable | NOT applicable |

`scripts/check-golden-queries.ts` enforces the split:

- A package with `koi.adapter-kind: "sandbox"` (wasm) MUST land assertions in `golden-replay.test.ts`.
- A package with `koi.adapter-kind: "edge-cloudflare"` MUST land assertions in `golden-edge-replay.test.ts`.
- `koi.adapter-kind: "edge-vercel"` is RESERVED for a future PR — no package currently uses it because `@koi/sandbox-vercel` is design-only and not published. Adding it requires the PR 5 promotion event documented below.
- A package landing in the wrong replay test is a CI failure.

Cloud golden queries use a mocked `fetch` (injected via the adapter's `client` config field) so replays are hermetic and no real provider tokens are needed in CI. The wasm golden query runs a real WebAssembly module in-process with no external dependencies.

## CI gates (must pass)

- [ ] `bun run typecheck` — strict TS6 across new packages
- [ ] `bun run lint` — Biome
- [ ] `bun run check:layers` — L2-only deps (`@koi/core` + L0u only)
- [ ] `bun run check:orphans` — sandbox-wasm and sandbox-cloudflare wired into `@koi/runtime`. `sandbox-vercel` is deferred to PR 5 (experimental, opt-in, not runtime-integrated) and is therefore EXEMPT from the orphan check.
- [ ] `bun run check:golden-queries` — 2 new queries (wasm, cloudflare) land assertions. Vercel golden-query coverage is deferred to PR 5.
- [ ] `bun run check:duplicates` — accept 5+ line cloud duplication only if Rule-of-Three justified inline
- [ ] `bun run test` — coverage ≥80%
- [ ] `provider-smoke.yml` — required workflow; blocks merge on cleanup failure or leaked artifacts

## Docs (Doc → Tests → Code)

Write before code:

- `docs/L2/sandbox-wasm.md` (PR 3)
- `docs/L2/sandbox-cloudflare.md` (PR 4)
- `docs/L2/sandbox-vercel.md` (PR 5 — experimental; written but not tied to PR 4 ship)

Each follows existing `docs/L2/sandbox-*.md` template: purpose, contract, config, capabilities, threat model, tests.

## Threat model

- **wasm:** in-process. Memory cap enforced by `WebAssembly.Memory({ maximum })`. CPU cap = wall-clock timeout (no instruction-count metering — `AbortSignal` only). No filesystem or network unless host imports are explicitly provided. Default config: zero host imports.
- **cloudflare/vercel:** remote. API tokens are secrets — validated for shape, never logged, never returned in errors. SSRF: deploy endpoint is hardcoded, invoke endpoint is pinned to provider-owned subdomains (`*.workers.dev`, `*.vercel.app`) — custom domains are out of scope. **`destroy()` does NOT guarantee remote cleanup succeeded**: the local handle is terminated reliably, but the remote artifacts may be `leaked` or `uncertain`, in which case `DestroyOutcome` reports the artifact identifiers and the orphan ledger plus tagged sweeper handle eventual cleanup. Operators MUST treat `destroyed-local-remote-leaked` and `destroyed-local-remote-uncertain` outcomes as **active cleanup incidents requiring follow-up**, not as successful teardown.
- **Worker B trust boundary differs by provider, and so does the cleanup-bound story:**
  - **Cloudflare:** Worker B is structurally non-public (`workers_dev: false`, no custom route, no public listener — provider-enforced). Even an orphaned Worker B is unreachable from the internet. Billing exposure and live-code exposure after a host crash are bounded by the **fleet sweeper Worker** (Cloudflare Cron Trigger, deployed automatically by the adapter, runs in the CF account independent of any koi adapter process) AND the **bounded DO-alarm liveness gate** (`host-lease-until` enforces that the DO alarm chain stops within 30 minutes of host crash): post-crash leak window ≈ **32 minutes**.
  - **Vercel (EXPERIMENTAL — UNBOUNDED ORPHAN RISK):** Worker B is **public-but-authenticated** — the deployment URL is internet-reachable from the moment Vercel materializes it; the trust boundary is **Vercel deployment protection (provider gate) + per-pair Ed25519 asymmetric signature (application-layer)**. The signing key lives in Worker A only; the verification key in Worker B's env is useless for forging. A leaked Worker B remains URL-reachable until DELETE; any Ed25519 verification bug becomes externally exploitable for the lifetime of the orphan. Vercel ships single-host only and is labeled EXPERIMENTAL because the spec **does not advertise a bounded post-crash cleanup guarantee** — the adapter cannot mechanically verify reconciler failure-domain separation. The reconciler (`koi-sandbox-sweep --watch --vercel`) is still a mandatory runtime prerequisite at construction (the adapter rejects without it) and must be operator-attested as topologically isolated, but its presence is best-effort cleanup, not a contract. Operators that cannot tolerate unbounded leaks MUST wait for a future PR with provider-owned cleanup primitives or mechanically-verified isolation. **Continuous deployment-protection drift detection (single source of truth — see normative Vercel section):** the adapter polls `GET /v9/projects/{projectId}` every **30 seconds** and, on the **FIRST** confirmed `200 OK` response showing protection downgraded, immediately POISONs every live instance with `VERCEL_PROTECTION_DOWNGRADED` and forces destroy/recreate. New invokes are halted by a process-local stop-flag the moment detection occurs, before the per-instance poison propagates. **There is no multi-observation grace window for a real downgrade** — that posture leaves a multi-minute public-but-weakened-gate exposure. API errors (5xx, timeouts) are tolerated up to 3 consecutive failures (~90s) and surface as `VERCEL_PROTECTION_POLL_UNAVAILABLE`, distinct from a confirmed downgrade.
- Operators MUST set up alerting on non-clean destroy outcomes regardless of provider, and additionally on Vercel: alerting on `VERCEL_FLEET_EXCLUSIVITY_LOST`, `VERCEL_RECONCILER_LOST`, and on the absence of recent reconciler heartbeats.

## Out of scope (deferred)

- WASI support (sandbox-wasm runs core WebAssembly only)
- Streaming output (no `onStdout`/`onStderr` on `EdgeInvokeRequest`; deferred until a future `EdgeFunctionStreamingAdapter` contract exists)
- KV / Durable Objects / Edge Config bindings (Cloudflare)
- Vercel Edge runtime vs Node runtime selection (defaults to Edge)
- `findOrCreate` persistence on cloud adapters (script reuse) — current PR creates fresh per `create()`

## PR plan (split per CLAUDE.md "<1500 lines logic" rule)

The implementation does not fit a single PR. The work is split into four sequential PRs with independent acceptance gates. Each PR is reviewable on its own; later PRs build on earlier ones.

| PR | Title | Scope | LOC budget |
|----|-------|-------|-----------|
| 1 | This spec | Design doc (`docs/superpowers/specs/2026-05-05-edge-sandboxes-design.md`) + a **stub marker prepended to `docs/L3/sandbox-stack.md`** noting "the lines below are pending reconciliation in PR 2 — see `docs/superpowers/specs/2026-05-05-edge-sandboxes-design.md` for the authoritative contract." This is the only mutation to the repo's contract docs in PR 1 and exists solely to prevent `main` from carrying two competing authoritative documents. No code, no L3 substantive rewrite. | ~600 lines markdown + 4-line marker |
| 2 | Kernel + runtime extension for edge adapters | New `@koi/core` types (`EdgeFunctionAdapter` etc.), `CreateKoiOptions` extension on `@koi/engine`, `koi.edge.*` accessor, CI script extensions for `koi.adapter-kind`, `docs/L3/sandbox-stack.md` rewrite, `golden-edge-replay.test.ts` skeleton. **Reconciles existing L3 doc with the new contract.** | ~700 LOC |
| 3 | `@koi/sandbox-wasm` | Full wasm executor package + binary scanner + tests + `docs/L2/sandbox-wasm.md` + golden replay assertion (uses the SandboxExecutor-style cassette path or the new edge replay; finalized in PR 2). | ~700 LOC |
| 4 | `@koi/sandbox-cloudflare` + `@koi/sandbox-sweep` (Cloudflare-only ship bundle) | Cloudflare adapter PLUS the fleet sweeper template auto-deployed by the adapter. Includes shim template with mandatory DO dedupe enforcement, SQLite ledger, provider-smoke workflow (CF-only adversarial scenarios), L2 docs (`sandbox-cloudflare.md`, `sandbox-sweep.md`), and CF edge cassette. **Vercel is explicitly NOT in the runtime-integrated shipping bundle** for the reasons documented in the Vercel section: cleanup is unbounded, reconciler isolation is operator-attested rather than mechanically enforced, and shipping such a public-orphan path as a default-available runtime adapter extends the blast radius of any auth bug. Cloudflare's multi-host story IS protected by the fleet sweeper from day one. | ~900 LOC |
| 5 (deferred — DESIGN-ONLY, NOT PUBLISHED) | `@koi/sandbox-vercel` design + internal prototype | The package is **NOT published to npm** in this release. Source lands in a `private` workspace that is excluded from the public-publish manifest. `KOI_ENV != production` gating is insufficient because staging/non-production environments routinely carry real credentials and side effects, and a correlated adapter/reconciler failure would leave authenticated public deployments alive indefinitely regardless of environment label. The Vercel design and prototype are kept in-tree for review/iteration; promotion to a published package is gated on either (a) Vercel exposing a provider-owned cleanup primitive (deployment TTL, scheduled-execution primitive, or authoritative inbound-liveness probe), or (b) a mechanically-verifiable isolation/fencing mechanism replacing operator attestation, AND a security review confirming the public-orphan failure mode is mechanically bounded. The L2 doc carries the EXPERIMENTAL — UNBOUNDED ORPHAN RISK label, the production-env reject, AND a "NOT INSTALLABLE — DESIGN-ONLY" notice. | ~600 LOC, design-only |

PRs 3 and 4 can land in parallel after PR 2 merges. PR 4 bundles `@koi/sandbox-sweep` because Cloudflare relies on the fleet-scoped sweeper Worker the adapter deploys (its source template lives in `@koi/sandbox-sweep`). Vercel's multi-host story AND its single-host story are both deferred to PR 5 (separate timeline, opt-in only).

## Acceptance

### PR 1 (this branch — design spec)

- [x] Design spec committed to `docs/superpowers/specs/`
- [x] Adversarial review converged (multiple Codex passes)
- [ ] User approval to proceed to PR 2

### PR 2 (kernel + runtime extension)

- [ ] New `@koi/core/edge-function-adapter.ts` lands with the documented type set
- [ ] `CreateKoiOptions` extended with `sandbox?` and `edgeAdapters?` fields
- [ ] `koi.edge.cloudflare` accessor reachable when populated, typed `undefined` when not. (`koi.edge.vercel` is intentionally NOT added in PR 2 — reserved for PR 5 promotion.)
- [ ] `scripts/check-golden-queries.ts` and `scripts/check-orphans.ts` accept the `koi.adapter-kind` field on `package.json`
- [ ] `docs/L3/sandbox-stack.md` rewritten to reflect `EdgeFunctionAdapter` contract (no remaining claims that Cloudflare/Vercel are `SandboxAdapter`s)
- [ ] `golden-edge-replay.test.ts` skeleton (one passing dummy assertion to prove wiring)
- [ ] Typecheck + lint + layer-check green
- [ ] PR < 1500 LOC

### PR 3 (`@koi/sandbox-wasm`)

- [ ] Package compiles, lints, typechecks under TS6 strict
- [ ] Unit tests pass with ≥80% coverage including adversarial fixtures (modules with internal memory, malformed LEB128)
- [ ] Layer check green (depends only on `@koi/core` + L0u)
- [ ] Orphan check green (wired into `@koi/runtime`)
- [ ] Golden query for wasm lands assertion via the path PR 2 finalized
- [ ] `docs/L2/sandbox-wasm.md` committed
- [ ] PR < 1500 LOC

### PR 4 (`@koi/sandbox-cloudflare` + `@koi/sandbox-sweep` — Cloudflare-only)

- [ ] Both packages compile, lint, typecheck under TS6 strict
- [ ] Unit tests pass with ≥80% coverage including failure paths (poison-on-timeout, mid-create failure, ledger crash recovery, dedupe under retry)
- [ ] Layer check green for both
- [ ] Orphan check green for both
- [ ] Golden edge replay covers `@koi/sandbox-cloudflare` with cassettes (Vercel cassette deferred to PR 5)
- [ ] `provider-smoke.yml` green: Cloudflare happy path + 4 adversarial scenarios + leak sweep (Vercel scenarios deferred to PR 5)
- [ ] `docs/L2/sandbox-cloudflare.md` committed with: orphan-handling section (CF fleet sweeper auto-deployed; bounded **~32-minute** post-crash leak window — derived from 30-minute `host-lease-until` + 90s alive TTL + 1-minute sweeper cadence; the DO-alarm liveness gate IS bounded on a host-originated 30-minute lease so a crashed host cannot keep the alive key fresh indefinitely), **v1 supports workloadClass: "A" (side-effect-free) only** (the create-time AST scan rejects any side-effect-shaped construct; class-B mediated outbound is deferred), structural-privacy claim for Worker B (provider-enforced via `workers_dev: false`)
- [ ] `@koi/sandbox-sweep` package PLUS the CF fleet-sweeper Worker source template (auto-deployed by `@koi/sandbox-cloudflare`) ship in this PR. The Vercel `--watch --vercel` reconciler CLI is deferred to PR 5.
- [ ] Sweep smoke test: deploy 3 stub artifacts, expire 1 lease, run sweep, assert exactly the expired artifact is deleted
- [ ] L2 doc `docs/L2/sandbox-sweep.md` covering operator deployment patterns ships in this PR (CF auto-deployed fleet sweeper only)
- [ ] PR < 1500 LOC

### PR 5 (`@koi/sandbox-vercel` — DEFERRED, DESIGN-ONLY, NOT PUBLISHED)

**This package is NOT published to npm and is NOT installable by external operators in this release.** It lives in a `private` workspace excluded from the public-publish manifest. The work below is internal prototype + design iteration; promotion to a published package requires a separate decision documented at the bottom of this section.

- [ ] Package compiles, lint, typecheck under TS6 strict
- [ ] `unsafelyEnableExperimentalProvider: true` config gate enforced; rejects in `KOI_ENV=production`
- [ ] `@koi/sandbox-sweep` extended with `--watch --vercel` CLI (operator-run, long-lived, on attested separate failure domain)
- [ ] `provider-smoke.yml` extended with Vercel adversarial scenarios + leak sweep (Vercel-specific job, gated to `unsafelyEnableExperimentalProvider`)
- [ ] `docs/L2/sandbox-vercel.md` committed with: **EXPERIMENTAL — UNBOUNDED ORPHAN RISK** label in the first section, **NOT FOR PRODUCTION** notice, **single-host-only** notice (multi-host explicitly unsupported), public-but-authenticated trust boundary for Worker B with **per-pair Ed25519 asymmetric signature** (signing key in Worker A only, verification key in Worker B only — NOT symmetric HMAC), Vercel deployment-protection requirement (provider gate, continuously revalidated by 30-second post-`ready` background poll; the **FIRST** confirmed downgrade observation immediately poisons live instances with `VERCEL_PROTECTION_DOWNGRADED` — fail-closed-on-first-observation, no multi-check grace; transient API errors are isolated as `VERCEL_PROTECTION_POLL_UNAVAILABLE`) PLUS Ed25519 (defense-in-depth), **always-on reconciler is a hard runtime prerequisite** running on operator-attested separate failure domain (adapter rejects with `VERCEL_RECONCILER_NOT_RUNNING` / `VERCEL_RECONCILER_SAME_FAILURE_DOMAIN` / `VERCEL_RECONCILER_ISOLATION_NOT_ATTESTED`), **NO bounded post-crash leak guarantee** — ~65-minute figure is best-effort telemetry only, fleet exclusivity via Vercel-KV ownership-checked Lua lease (TTL 90s, renewal 30s, 2-failure tolerance ~60s — poison fires at least 30s before lease TTL elapses) plus lease-epoch fencing on every KV mutation, reconciler delete-confirmation 30 minutes past `koi-stale-after` AND `processInstanceId` (NOT `hostUUID`) stamped on the artifact has lost the exclusivity lease, dedicated-Vercel-project requirement (`koiOnlyProjectAttested: true`), workloadClass: "A" only (Vercel inherits the same v1 class-A restriction; class B with assertIdempotent is deferred together with the rest of the class-B work)
- [ ] **NOT** wired into `@koi/runtime` (no `koi.edge.vercel` accessor)
- [ ] **NOT** included in `check:orphans` / `check:golden-queries` required gates
- [ ] Promotion to runtime-integrated status REQUIRES one of: (a) Vercel ships a provider-owned cleanup primitive, OR (b) a mechanically-verifiable isolation/fencing mechanism replaces operator attestation. Until then PR 5 ships as opt-in only.
