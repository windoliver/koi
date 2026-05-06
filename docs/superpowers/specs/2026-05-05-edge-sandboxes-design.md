# Edge Sandboxes Design (issue #1377)

**Date:** 2026-05-05
**Issue:** [#1377](https://github.com/windoliver/koi/issues/1377) — v2 Phase 3-sandbox-3
**Branch:** `feat/issue-1377-edge-sandboxes`

## Status: Design spec only

This branch contains only this spec. It is not the implementation. Per CLAUDE.md "PR < 1500 lines logic", the implementation is split across multiple follow-up PRs (see "PR plan" below). Reviewing this branch reviews the design; reviewing the implementation requires the follow-up PRs.

## Goal

Port three v1 sandbox packages to v2:

- `@koi/sandbox-wasm` — in-process WebAssembly executor
- `@koi/sandbox-cloudflare` — Cloudflare Workers deploy + invoke adapter
- `@koi/sandbox-vercel` — Vercel Functions deploy + invoke adapter

All three are L2 packages, depend only on `@koi/core` (and minimal L0u utilities), implement contracts already defined in `packages/kernel/core/`, and ship in one PR.

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
  readonly timeoutMs?: number;        // capped by profile.resources.timeoutMs
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
  readonly create: (config: { code: string; profile: SandboxProfile }) => Promise<Result<EdgeFunctionInstance, KoiError>>;
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

`docs/L3/sandbox-stack.md` (lines ~308-337) currently documents `createCloudflareAdapter` and `createVercelAdapter` as returning `SandboxAdapter` via `createCloudSandbox()`. This is a forward-looking placeholder from a prior planning pass — the v2 packages do not exist yet on `main`. The L3 doc MUST be updated as part of this PR to reflect the actual contract being shipped:

- The packages return `EdgeFunctionAdapter`, not `SandboxAdapter`.
- They are NOT consumed by `createCloudSandbox()` or by `@koi/sandbox-router`.
- They are accessed through the new `koi.edge.cloudflare` / `koi.edge.vercel` slots on the runtime (see Runtime Integration below).
- The L3 doc gets a new "Edge functions" subsection that documents the `invoke()`-only contract distinct from the process-level `SandboxAdapter` contract.

This doc update is a required deliverable of this PR (see Acceptance below) so that no documented contract conflicts with what ships.

### Adapter-enforced idempotency via strongly-consistent durable dedupe store

The duplicate-side-effect hazard from timeout/abort/destroy + per-isolate dedupe is unacceptable on the honor system. The adapter mechanically enforces cross-retry dedupe by requiring operators to bind a **strongly-consistent** provider-side store (eventually-consistent stores like Cloudflare KV are insufficient — within their 60-second propagation window, a cross-instance retry can miss a just-written entry and double-execute the handler).

#### Two-worker isolation: handler code never sees dedupe credentials

The deployed shim is a **two-worker** (or two-function) pattern, not one. Operator handler code never has access to dedupe state or credentials:

- **Worker A — `koi-dedupe-gateway`:** koi-owned. Holds the Durable Object binding (Cloudflare) or Vercel KV credentials. Source is the same `≤80 LOC` shim template the koi packages ship — operators do not modify it. Exposes only one method to Worker B: `runWithDedupe(operationId, payloadEnvelope)` which (a) checks the durable dedupe store, (b) if fresh, invokes Worker B via Service Binding (CF) or internal `fetch` (Vercel), (c) commits the result atomically. Worker A never executes operator code.
- **Worker B — `koi-handler-runner`:** runs the operator's handler. Has NO dedupe binding, NO dedupe credentials, NO direct access to KV/DO. It receives `payload`, `operationId`, and `requestId` as call arguments from Worker A and returns the handler result. The bearer token (`KOI_INSTANCE_TOKEN`) for shim-level auth is also held by Worker A only — Worker B does not need it because Worker A authenticates the inbound request before invoking it.
- **Communication:** Cloudflare uses Service Bindings (`env.HANDLER_RUNNER.fetch(req)`) — a private internal RPC channel that requires no auth and cannot be reached from outside the account. Vercel does **NOT** rely on `x-vercel-signature` (that header is for Vercel-originated webhooks/drains, not deployment-to-deployment calls) and does **NOT** rely on Deployment Protection as caller identity (its bypass uses a project-scoped `x-vercel-protection-bypass` secret that any deployment in the project could replay). Instead, the Vercel pair uses a **per-pair HMAC shared secret** generated host-side at create time, provisioned to Worker A and Worker B as the same env-secret value, and **never reused across pairs**. Each request from Worker A to Worker B carries an HMAC-SHA-256 over `${operationId}:${requestId}:${nonce}:${timestampMs}` keyed on this per-pair secret; Worker B verifies the HMAC, rejects timestamps older than 60s (replay protection), and rejects mismatched HMACs with 401. Because the secret is per-pair (not project-wide, not Vercel-issued), a different deployment in the same project that learns Worker B's URL still cannot forge a request — it does not hold the pair's secret. This is explicit per-pair trust, not provider-mediated identity. The legacy `VERCEL_INTER_DEPLOYMENT_SECRET` term in this doc refers to the same per-pair HMAC secret.
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

The adapter then binds the koi-shipped DO class to that namespace as part of the create flow. To prevent operator override or stale class versions, the adapter calls `GET /workers/scripts/{koi-dedupe-gateway-name}` after deploy and verifies the script's source hash matches the expected `koi-dedupe-gateway-source-sha256` constant baked into the package. A mismatch returns `KoiError { code: "DEDUPE_GATEWAY_TAMPERED" }` and the adapter refuses to construct. This makes the DO trust boundary structural: the operator cannot ship a buggy or backdoored DO class through the adapter even if they wanted to.

DO is the only Cloudflare primitive with linearizable single-key consistency.

**Dedupe state machine** (operates on a single Durable Object instance per `operationId`):

```
fresh → claimed (claimer holds lease) → completed (terminal: result cached for 24h)
                              \-------> failed-permanent (terminal: error cached for 24h, retries see error)
                              \-------> claim-expired (lease ran out: any caller can transition to claimed)
```

Rules:

- `claim`: atomic compareAndSwap from `fresh|claim-expired` to `claimed`. The caller writes its `requestId`, `claimedAt`, and `leaseUntil = claimedAt + 60_000ms` into the DO's transactional storage. Returns `{ status: "fresh" }` to the new owner, `{ status: "in-progress", claimer: <other_requestId>, leaseUntil }` to losers.
- **Heartbeat lease while running:** the running isolate calls `extendLease` every 30 seconds — atomic CAS that sets `leaseUntil = now + 60_000ms` IFF the current claimer's `requestId` matches. If the heartbeat fails (isolate crashed, evicted), the lease expires after 60s and another isolate can take over via the `claim-expired` transition.
- **Atomic completion (fail-closed on persistence failure):** `complete` is a single transaction that writes `{ status: "completed", result, statusCode, completedAt, ttlExpiresAt: now + 86400_000ms }` AND clears the claim. If the handler succeeded but `complete` fails (network error, DO transient), the isolate retries `complete` up to 3 times with backoff. **After 3 failures, the isolate returns `503 DEDUPE_PERSISTENCE_FAILED` to the caller WITHOUT serving the handler's result.** The instance is poisoned. The host-side adapter, on receiving this response, transitions the local handle to POISONED and the caller's `invoke()` rejects with `KoiError { code: "DEDUPE_PERSISTENCE_FAILED" }`. The handler's external side effects already happened — but no result is returned to the caller, and the next retry of the same `operationId` will see the still-active claim, wait for it to expire, and then re-run. Because the workload-class restriction (`assertIdempotent: true`) requires handler-level idempotency at side-effect targets, this re-run is safe. **There is no path where the adapter reports success without persisting a terminal record.**
- **Atomic failure:** `fail` writes `{ status: "failed-permanent", error, failedAt, ttlExpiresAt: now + 86400_000ms }` for handler errors that the operator wants cached (e.g., validation failures with no retry semantics). The handler signals this via a special return shape `{ koi: { failed: true, error } }`. Default behavior is to NOT cache failures — the next retry runs the handler fresh.
- **Stuck-claim recovery:** if a caller observes `claim-expired` with a non-null result (handler ran but didn't complete the DO), it does NOT trust the partial state. It transitions to `claimed` itself and re-runs the handler. This is the only path where idempotency-at-side-effect-targets matters; the workload-class restriction covers it.

The shim handler:

All dedupe keys are **fleet-namespaced** to prevent cross-tenant collision when multiple deployments share a DO namespace. The effective key is `${ownerId}:${operationId}`, NOT raw `operationId`. Two fleets reusing the same `operationId` value never contend on the same DO instance because their `ownerId` prefixes differ.

```js
const dedupeKey = `${ownerId}:${operationId}`;
const stub = KOI_DEDUPE_DO.get(KOI_DEDUPE_DO.idFromName(dedupeKey));
const claimResult = await stub.fetch("https://do/claim", {
  method: "POST",
  body: JSON.stringify({ operationId, requestId }),
});
const claim = await claimResult.json();
// claim.status: "fresh" | "in-progress" | "completed"
if (claim.status === "completed") {
  return new Response(JSON.stringify(claim.result), { status: claim.statusCode });
}
if (claim.status === "in-progress") {
  // poll the DO until it transitions to "completed" or timeout fires
  return await waitForCompletion(stub, operationId, requestId, timeoutMs);
}
// claim.status === "fresh" — this isolate owns the operation
const result = await handler({ payload, operationId, requestId });
await stub.fetch("https://do/complete", {
  method: "POST",
  body: JSON.stringify({ operationId, result, statusCode: 200 }),
});
return new Response(JSON.stringify(result));
```

The DO class implements `claim` atomically (single-threaded execution per object id), guarantees only one isolate transitions a key to `in-progress`, and persists results to its built-in transactional storage with 24h TTL. Cross-instance retries (after `destroy()` + new `create()`) hit the same DO id (because `operationId` keys the lookup) and observe the prior outcome. **This is the only provider primitive that makes cross-retry dedupe a real guarantee for Cloudflare.**

#### Vercel: Vercel KV (Upstash Redis) with `SET NX EX`

`createVercelAdapter` REQUIRES `config.dedupeKvUrl: string` and `config.dedupeKvToken: string` — a Vercel KV connection (Upstash Redis-compatible REST API). Vercel Edge Config is read-only and write-async, so it cannot serve as a dedupe store. Vercel KV uses Redis primitives which support strongly-consistent `SET NX EX` (set if not exists, with expiry) — the operation is atomic on a single key. The adapter wires the connection as bindings `KOI_DEDUPE_KV_URL` and `KOI_DEDUPE_KV_TOKEN` so the shim can issue authenticated requests.

**Dedupe state machine** (parallels the Cloudflare DO design):

All Vercel KV keys are **fleet-namespaced** with `ownerId` to prevent cross-tenant collision when multiple deployments share a KV instance. The shim manages three keys per `operationId`, all prefixed by `ownerId`:

- `${ownerId}:claim:${operationId}` — holds the active claimer's `requestId` with a 60-second TTL (heartbeat lease).
- `${ownerId}:result:${operationId}` — holds the cached result with a 24-hour TTL.
- `${ownerId}:failed:${operationId}` — cached terminal failures (24h TTL).

Two fleets reusing the same `operationId` value never contend because their key prefixes differ. The shim reads `ownerId` from a worker env var (`KOI_OWNER_ID`) injected at deploy time by the koi adapter, NOT from the request — clients cannot spoof a different owner.

Atomic operations via Upstash Redis pipelined commands:

```js
// All keys fleet-namespaced via ownerId from KOI_OWNER_ID env var (set by adapter at deploy)
const ns = KOI_OWNER_ID; // injected at deploy time
const claimKey = `${ns}:claim:${operationId}`;
const resultKey = `${ns}:result:${operationId}`;
const failedKey = `${ns}:failed:${operationId}`;

// 1+2. Atomic check-or-claim via single Lua EVAL (no race window between check and claim).
// Returns one of: "result:<json>" | "failed:<json>" | "claim:fresh" | "claim:in-progress:<requestId>"
const CHECK_OR_CLAIM_LUA = `
  local r = redis.call('GET', KEYS[1])
  if r then return 'result:'..r end
  local f = redis.call('GET', KEYS[2])
  if f then return 'failed:'..f end
  local c = redis.call('GET', KEYS[3])
  if c then return 'claim:in-progress:'..c end
  redis.call('SET', KEYS[3], ARGV[1], 'EX', '60')
  return 'claim:fresh'
`;
const checkResult = await kvCommand("EVAL", [CHECK_OR_CLAIM_LUA, "3", resultKey, failedKey, claimKey, requestId]);
if (checkResult.startsWith("result:")) {
  return new Response(checkResult.slice("result:".length), { status: 200 });
}
if (checkResult.startsWith("failed:")) {
  return new Response(checkResult.slice("failed:".length), { status: 500 });
}
if (checkResult.startsWith("claim:in-progress:")) {
  // Another isolate owns it; poll for terminal state
  return await waitForTerminal(resultKey, failedKey, timeoutMs);
}
// checkResult === "claim:fresh" — we own the operation

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
const heartbeat = setInterval(async () => {
  const result = await kvCommand("EVAL", [HEARTBEAT_LUA, "1", claimKey, requestId, "60"]);
  if (result === 0) {
    // We no longer own the claim. Some other isolate has taken it (lease expired and got reclaimed).
    // Stop the heartbeat and POISON ourselves — the in-flight handler must NOT commit results.
    lostLease = true;
    clearInterval(heartbeat);
  }
}, 30_000);

try {
  const result = await handler({ payload, operationId, requestId });
  clearInterval(heartbeat);
  if (lostLease) {
    // We ran handler but our lease was stolen mid-flight. We must not commit — another isolate
    // is now authoritative. Log that side effects MAY have leaked (workload-class accepts this) and return.
    console.warn("DEDUPE_LEASE_LOST_DURING_HANDLER", { operationId, requestId });
    return new Response(JSON.stringify({ koi: { error: "LEASE_LOST" } }), { status: 503 });
  }

  // 4. Atomic ownership-checked commit via Lua EVAL: write result + delete claim ONLY IF still owned.
  const COMMIT_LUA = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      redis.call('SET', KEYS[2], ARGV[2], 'EX', 86400)
      redis.call('DEL', KEYS[1])
      return 1
    else
      return 0
    end
  `;
  const resultJson = JSON.stringify(result);
  if (resultJson.length > MAX_DEDUPE_RESULT_BYTES /* = 8 MB, configurable */) {
    // Result too large to cache durably. FAIL CLOSED: do not return success, do not release claim.
    // The handler's side effects already happened, but the caller does not get a success result.
    // Same posture as DEDUPE_PERSISTENCE_FAILED above. Lease will expire normally, retries re-run.
    console.error("DEDUPE_RESULT_TOO_LARGE", { operationId, size: resultJson.length });
    return new Response(JSON.stringify({ koi: { error: "RESULT_TOO_LARGE", maxBytes: MAX_DEDUPE_RESULT_BYTES } }), { status: 503 });
  }
  const committed = await kvCommand("EVAL", [COMMIT_LUA, "2", claimKey, resultKey, requestId, resultJson]);
  if (committed === 0) {
    // Lost ownership between handler completion and commit attempt. Don't write result; another
    // isolate will produce its own result. Side effects may have leaked (workload-class accepts).
    console.warn("DEDUPE_OWNERSHIP_LOST_AT_COMMIT", { operationId, requestId });
    return new Response(JSON.stringify({ koi: { error: "OWNERSHIP_LOST" } }), { status: 503 });
  }
  return new Response(resultJson, { status: 200 });
} catch (err) {
  clearInterval(heartbeat);
  // Don't cache transient handler errors. Ownership-checked DEL only.
  const RELEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
  await kvCommand("EVAL", [RELEASE_LUA, "1", claimKey, requestId]);
  throw err;
}
```

Rules mirror the Cloudflare design:
- Strong consistency via Redis `SET NX` for the claim and `MGET` for the terminal-cache check.
- 60-second lease with 30-second heartbeat. **All heartbeat, commit, and release operations use ownership-checked Lua scripts** that compare the current value of `claim:${operationId}` against this isolate's `requestId` before mutating anything. A stale claimer whose lease expired and was re-acquired by another isolate cannot extend its lease, write results, or delete the new owner's claim — the Lua script's `GET == ARGV[1]` guard fails and the operation returns 0.
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

#### `assertIdempotent: true` still required

The flag is now belt-and-braces: the dedupe store is the enforcement mechanism, the flag is the operator's confirmation that they understood the contract and provisioned the store correctly. The flag's documentation states the operator certifies handler-level idempotency in addition to the durable dedupe.

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
      readonly vercel?: EdgeFunctionAdapter;
    };
  }
  ```
  Note: `sandbox` field also does not yet exist on `CreateKoiOptions` per current `packages/kernel/engine/src/types.ts`. Adding both `sandbox` and `edgeAdapters` is part of this PR. ~25 LOC.
- `packages/kernel/engine/src/koi.ts` — extend the runtime constructor to expose the registered adapters under a typed `koi.edge.{cloudflare,vercel}` accessor. ~40 LOC.
- Engine assembly tests assert the slots are reachable when populated and absent (typed `undefined`) when not. ~50 LOC.

**`@koi/runtime` additions (L3 meta):**

- `packages/meta/runtime/src/index.ts` — the runtime convenience bundle re-exports the new edge adapter types and provides a no-default-adapters factory. Edge adapters are explicitly opt-in; the runtime does NOT bundle Cloudflare/Vercel by default since they require API tokens. ~20 LOC.
- New test `packages/meta/runtime/src/__tests__/golden-edge-replay.test.ts` — replays recorded Cloudflare/Vercel API responses (cassettes) against `createCloudflareAdapter` and `createVercelAdapter` with mocked `fetch`. Asserts the full `create → invoke → destroy` happy path produces the expected ATIF trajectory. ~150 LOC.
- New script `packages/meta/runtime/scripts/record-edge-cassettes.ts` — records cassettes against real (or stubbed) Cloudflare/Vercel APIs for the golden replay. Mirrors `record-cassettes.ts` but produces edge-specific fixtures. ~120 LOC.

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
- **Worker B is structurally non-public:** Worker B is deployed with `workers_dev: false` and **no custom route or activation step is ever performed on it**. It has no public URL and is unreachable from the open internet. Worker B is invokable ONLY via:
  - **Cloudflare:** Service Binding from Worker A (intra-account RPC; provider-enforced, no public listener).
  - **Vercel:** signed inter-deployment fetch from Worker A. Worker B verifies the `x-vercel-signature` header against `VERCEL_INTER_DEPLOYMENT_SECRET` (per-fleet, rotated periodically); requests without the signature are rejected with 401 regardless of source.
  Worker B's deploy step is steps 1+2 ONLY (deploy + secrets). The activation step (3) flips reachability for Worker A only. A future PR could expose Worker B for direct invocation by adding its own auth, but this PR forbids that path.
- **Both artifacts tracked end-to-end:** the create state machine, orphan ledger, sweeper, and `destroy()` track the pair as a unit. Schema additions:
  - SQLite ledger gains `companion_artifact_name` (Cloudflare) / `companion_deployment_id` + `companion_attempt_id` (Vercel) — the second artifact's identity is persisted alongside the first.
  - Provider-side ownership tags include both artifacts' UUIDs in `koi-pair-uuid` so the sweep can identify a half-leaked pair from either side and clean both.
  - `destroy()` issues two DELETEs (Worker A then Worker B for CF, or both deployments for Vercel) atomically wrapped in a single mutex. `DestroyOutcome.providerArtifact` is now `string[]` reporting both names; if either DELETE fails the outcome includes the full pair so the orphan ledger captures both.
  - Create-failure cleanup follows the same logic: every failure step issues DELETEs against any artifact already deployed (Worker A is deployed first, so it is the one that may exist on early failures).
- **Per-attempt client-side identity (Vercel-recovery key):** Vercel assigns `deploymentId` server-side, so a create timeout before the response returns can leave the host without an identity to use for cleanup. To make every create attempt independently recoverable, the adapter generates a per-attempt UUID `attemptId = randomUUID()` BEFORE issuing the deploy POST and writes it to deployment metadata: `meta = { ..., "koi-attempt-id": attemptId }`. On any create failure where the response did not return (timeout, network error, or unparseable response), the adapter calls `GET /v6/deployments?meta-koi-attempt-id=${attemptId}` to discover the `deploymentId` of the artifact (if it materialized) and uses it for the cleanup DELETE. The `attemptId` itself is recorded in the orphan ledger so a host crash before the `GET` resolves still leaves a deterministic recovery key — the next adapter to read the ledger can complete the lookup. Cloudflare uses the deterministic `scriptName` directly; Vercel uses the `attemptId` lookup as its equivalent.

#### Create-failure state machine (orphan-safe)

Remote create involves a **paired-artifact state machine** (Worker B handler-runner deployed first, Worker A gateway second), chosen so that **a partially-created artifact is never reachable with secrets attached** AND so Worker A cannot be activated until Worker B is verified deployable:

| Step | Artifact | Action | On failure → cleanup |
|------|----------|--------|----------------------|
| 1 | Worker B | `PUT /workers/scripts/${B-name}` with `workers_dev: false` (deploy handler bytes; private). | Step 1 failure: no remote artifact; no cleanup needed. |
| 2 | Worker B | `PUT /workers/scripts/${B-name}/secrets` for user-supplied `env` (operator domain secrets the handler needs). | Step 2 failure: DELETE Worker B (private; no risk). |
| 3 | Worker B | `PUT /workers/scripts/${B-name}/secrets` for `VERCEL_INTER_DEPLOYMENT_SECRET` (CF: skip — Service Bindings need no shared secret). Worker B is now deployable but not yet bound from A. | Step 3 failure: DELETE Worker B. |
| 4 | Worker A | `PUT /workers/scripts/${A-name}` with `workers_dev: false` AND a binding declaration that points to Worker B (CF: `services` block in script settings; Vercel: nothing at the binding layer — A invokes B by deployment URL plus per-pair HMAC, no Vercel-mediated identity). | Step 4 failure: DELETE Worker B (sole leaked artifact at this point). |
| 5 | Worker A | `PUT /workers/scripts/${A-name}/secrets` for `KOI_INSTANCE_TOKEN`, `KOI_OWNER_ID`, dedupe credentials, AND (Vercel only) `VERCEL_INTER_DEPLOYMENT_SECRET` (the same fleet-scoped secret provisioned to Worker B in step 3 — Worker A signs with it; Worker B verifies with it). Cloudflare skips the inter-deployment secret because Service Bindings are an account-internal RPC channel that needs no shared secret. | Step 5 failure: DELETE Worker A then Worker B (both leaked, both private — secrets attached but unreachable). |
| 6 | Worker A | **Service Binding probe** (CF only): issue an internal probe via the binding to verify Worker B responds. Vercel: synthetic signed `/health` POST to Worker B's deployment URL. | Step 6 failure: DELETE Worker A then Worker B. The trust binding could not be verified before activation. |
| 7 | Worker A | **Activation** (the single step that makes A publicly reachable): `PATCH /workers/scripts/${A-name}/subdomain` to set `enabled: true` (CF) or `PATCH /v13/deployments/${A-id}/promote` (Vercel). Worker A is now reachable. Worker B remains private. | Step 7 failure: DELETE Worker A then Worker B (A might have been activated briefly; the bearer token is the only auth path so an unverified leak window is bounded). |
| 8 | — | Instance enters `ready`. Lease renewal heartbeat starts; worker-alive heartbeat begins on Worker A. | — |

Failure at any step before step 7 means Worker A is **not externally invokable** (still `workers_dev: false`), and Worker B is **never** externally invokable (always `workers_dev: false`). Even if cleanup races leave artifacts behind, no attacker can invoke either one. **Custom domain activation is explicitly out of scope** for the same reasons described in earlier rounds (host-side endpoint validation accepts only `*.workers.dev` and `*.vercel.app`).

The state machine is `allocating → b-deploying-private → b-secrets-uploading → b-binding-secrets-uploading → a-deploying-private → a-secrets-uploading → a-binding-probe → activating → ready`, with cleanup edges from every state to the appropriate combination of `DELETE Worker A` and/or `DELETE Worker B`.
4. (only if step 3 succeeded) instance enters `ready`; the host stores the activated URL and `invoke()` becomes available.

Failure at any step before step 3 means the worker is **not externally invokable** even if the cleanup DELETE races. This is a structural guarantee, not a best-effort one — Cloudflare's `workers_dev: false` default + no custom route is a hard provider-level reachability gate.

States:

```
allocating → deploying-unreachable → secrets-uploading → activating → ready
        \           \                       \                \
         \           \                       \                +--> create failure → cleanup (was reachable briefly)
          \           \                       +----------------> create failure → cleanup (unreachable, secrets attached but inert)
           \           +-----------------------------------------> create failure → cleanup (unreachable, no secrets)
            +---------------------------------------------------> no remote artifact yet
```

The `unreachable` qualifier on intermediate states is a real provider-side property, not a documentation note. Until the `activating` step completes, `https://{name}.{subdomain}.workers.dev` returns a Cloudflare 522/523 (no route configured), regardless of what the worker code does.

**Two-worker authentication (Worker A holds the token; Worker B never sees it):**

URL secrecy and provider-side protection are not enough on their own. Once Worker A (`koi-dedupe-gateway`) is activated, anyone who learns the URL can hit it. To close this gap, the adapter generates a per-instance authentication token at `create()` time and Worker A enforces it on every inbound request:

- During `create()`, the host generates `instanceToken = randomBytes(32).toString("base64url")` (256 bits). This token is uploaded as a **Worker A secret** only — `KOI_INSTANCE_TOKEN` is bound to Worker A, never to Worker B. Worker B's deploy step does not include this secret.
- Worker A's request handler reads `KOI_INSTANCE_TOKEN` from its own secrets and rejects any incoming request whose `Authorization: Bearer <token>` header does not match exactly. Constant-time comparison; 401 with no body on mismatch. Applies to `/invoke`, `/cancel`, every external endpoint.
- Worker A → Worker B communication does NOT use `KOI_INSTANCE_TOKEN`. Cloudflare uses Service Bindings (private intra-account RPC, no auth required). Vercel uses inter-deployment calls signed with `x-vercel-signature` derived from a separate `VERCEL_INTER_DEPLOYMENT_SECRET` rotated per-fleet. **Both Worker A and Worker B receive this secret** — Worker A holds it to sign outbound requests, Worker B holds it to verify inbound requests. The koi adapter generates one fleet-scoped secret per `ownerId`, provisions it to Worker B in step 3 of the create state machine, and to Worker A in step 5. The bearer `KOI_INSTANCE_TOKEN` never enters Worker B's environment; the inter-deployment secret never leaves the worker pair.
- Worker B's deployment receives the user-supplied `env` secrets (operator's domain credentials needed by the handler) but NOT `KOI_INSTANCE_TOKEN` and NOT `KOI_DEDUPE_KV_TOKEN` / DO bindings. A malicious handler in Worker B can read its own `env` secrets (operator-supplied, expected) but cannot exfiltrate the gateway's auth or dedupe credentials.
- The host-side `EdgeFunctionInstance` retains `instanceToken` in private state and sends `Authorization: Bearer ${instanceToken}` to Worker A only. Token never logged or exposed in public API surface.
- `destroy()` deletes both Worker A and Worker B (lifecycle below); both secrets are removed atomically with their respective deployments.
- This is mandatory. Worker A's handler refuses to start if `KOI_INSTANCE_TOKEN` is unset; Worker B's handler refuses to start if `VERCEL_INTER_DEPLOYMENT_SECRET` (or CF Service Binding sentinel) is unset. Defense-in-depth against misconfigured deploys.

For Vercel, the analogous gate (for pre-activation reachability) requires **adapter-enforced deployment protection**, not an external account default:

- The adapter's `createVercelAdapter(config)` requires `config.projectId` and verifies via `GET /v9/projects/{projectId}` at construction time that the project has `ssoProtection.deploymentType` (or `passwordProtection.deploymentType`) set to `"all"` or `"prod_deployment_urls_and_all_previews"`. If protection is disabled or scoped narrower, `createVercelAdapter` returns `KoiError { code: "VERCEL_PROTECTION_REQUIRED", reason: "preview-protection-not-enforced" }` and refuses to construct.
- **Uncached re-check inside every `create()`:** project protection settings can drift after adapter construction (operator changes them on the dashboard). Each `create()` therefore re-issues the same `GET /v9/projects/{projectId}` check IMMEDIATELY before any deploy mutation, with **no caching of allow results**. Allow decisions are evaluated against fresh provider state on every create. The optional cache stores ONLY negative/terminal failures (e.g., `VERCEL_PROTECTION_REQUIRED`) for 30 seconds to short-circuit retries against a known-bad project; a positive `protection-enforced` result is never cached and never reused. This bounds API rate on the failure path while preserving the safety property on the allow path. If the live check shows protection has been disabled or scoped narrower, `create()` returns `VERCEL_PROTECTION_REQUIRED` and never deploys. The structural reachability invariant is therefore guarded both at adapter construction (for fast failure of misconfigured deployments) and at every create call with provider-fresh data (against post-construction drift).
- Each deployment is created with `target: "preview"` until activation, so it lands behind the protection gate. Activation flips `target: "production"` after secrets and protection are confirmed. **Custom-domain attachment is explicitly out of scope for this PR** (matching the Cloudflare custom-route exclusion above): trusting an arbitrary hostname during activation would force the adapter to send `Authorization: Bearer ${instanceToken}` payloads to a non-Vercel-owned endpoint, which the spec's threat model forbids without an ownership-verification protocol that does not exist yet. The host-side endpoint validation only accepts `https://${deploymentId}-*.vercel.app` and `https://${deploymentId}.vercel.app` URLs; anything else is rejected with `KoiError { code: "ENDPOINT_NOT_TRUSTED" }`.
- Pre-activation, the preview URL is reachable only with a valid Vercel SSO/password token bound to that project. The koi adapter never publishes that URL externally; even if leaked, the protection gate stops anonymous invocation.
- The smoke workflow (`provider-smoke.yml`) includes a `vercel-protection-required` scenario: temporarily disable protection on the test project, attempt `createVercelAdapter`, assert it returns `VERCEL_PROTECTION_REQUIRED` and refuses to construct. Re-enable, assert success.

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
    script_name TEXT,                   -- Cloudflare: required
    deployment_id TEXT,                 -- Vercel: NULL until discovered; recovery via attempt_id
    deployment_url TEXT,                 -- Vercel: NULL until discovered
    attempt_id TEXT,                     -- Vercel: required (per-attempt UUID written to deployment.meta.koi-attempt-id)
    empty_lookups INTEGER NOT NULL DEFAULT 0, -- Vercel reconciliation: consecutive empty lookups before row removal
    last_empty_lookup_at TEXT,           -- Vercel reconciliation: timestamp of most recent empty lookup
    created_at TEXT NOT NULL,
    last_tried_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_orphans_provider_scope ON orphans (provider, account_id, team_id, project_id, owner_id);
  ```
  `id` is `cloudflare:${accountId}:${scriptName}` or `vercel:${teamId ?? "_personal"}:${projectId}:${attemptId}` — deterministic and known **before** the deploy POST is issued, so the orphan can be persisted on any failure path including create timeouts where `deploymentId` was never returned. `deploymentId`/`deploymentUrl` are stored as updatable attributes that get filled in once the post-timeout `GET /v6/deployments?meta-koi-attempt-id=...` lookup discovers them. Cloudflare uses `scriptName` (deterministic by construction); Vercel uses `attemptId` (deterministic by construction). Both keying schemes are independent of any server-assigned identifier.
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
- **Ownership-tagged artifacts + heartbeat lease (cleanup gated on staleness, not just tags):** every create attempt tags the deployed artifact with provider-side metadata identifying it as koi-managed AND a heartbeat lease tag that says "this artifact is in active use until time X":
  - **Cloudflare:** Workers `tags` field on the script: `["koi-managed:v1", "koi-owner:${ownerId}", "koi-stale-after:${ISO_TIMESTAMP}"]`.
  - **Vercel:** `meta` object on deployments: `{ "koi-managed": "v1", "koi-owner": "${ownerId}", "koi-stale-after": "${ISO_TIMESTAMP}" }`.
  At create time `koi-stale-after = now + 5 minutes`. While the instance is alive, the host-side adapter renews this tag every **2 minutes** via `PATCH /workers/scripts/{name}/tags` (CF) or `PATCH /v13/deployments/{id}/meta` (Vercel) — set to `now + 5 minutes`. The renewal cadence is short enough that a host crash leaves the artifact reclaimable within ~5 minutes (vs. 24 hours), bounding cross-host leak exposure to a small window. On `destroy()` the entire artifact is deleted. On host crash, the tag stops renewing and naturally expires; any sweeper picks it up once `koi-stale-after` is in the past.
- **Continuous sweep, not nightly:** the sweep is NOT a once-a-day cron. A continuous-mode sweeper runs every minute (configurable) and immediately deletes any artifact whose `koi-stale-after` has passed.
- **Cloudflare uses a single fleet-scoped sweeper worker (NOT a cron in every instance):** the cleanup cron is NOT embedded in per-instance Worker A — that would scale linearly with instance count and cause sweep/renewal interference + API rate-limit issues. Instead, the koi adapter deploys ONE long-lived **fleet sweeper** worker per `ownerId`: `koi-sandbox-cleanup-${ownerId}`. This worker has the same Cloudflare Cron Trigger (every minute) and is the ONLY artifact in the account that scans for stale `koi-managed:v1` + `koi-owner:${ownerId}` workers and deletes them.
  - **Sweeper existence is verified before every `create()`, no caching.** `GET /workers/scripts/koi-sandbox-cleanup-${ownerId}` is issued at the start of every `create()` call. If the sweeper is absent, the adapter deploys it from the package's fixed source template before proceeding with the per-instance create state machine. The earlier draft cached the existence check for an hour — that introduced a window in which a self-deleted sweeper could leave newly-created instances without a backstop. The cache is removed; the per-create GET is single-digit-millisecond round-trip and not a measurable cost vs. the multi-second Worker deploy that follows.
  - **The sweeper does NOT self-delete.** The earlier "self-delete when zero managed workers remain" rule is removed because it created the same backstop gap: a long-lived adapter with a cached positive existence check could call `create()` against an account whose sweeper had self-deleted, deploying new instances that no sweeper was watching. The sweeper instead remains as a fleet-scoped permanent artifact, owned per `ownerId`. If an operator wants to fully shut down a fleet they invoke `@koi/sandbox-sweep --teardown --cloudflare --owner-id=${ownerId}`, which deletes the sweeper as the explicit final step after asserting zero managed workers remain.
  - Per-instance Worker A focuses on invoke/dedupe only — no cron trigger, no scanning. This bounds account-wide API traffic to one minute-by-minute scan regardless of instance count.
  - Cross-host leak window is bounded by the 5-minute lease + 1-minute fleet-sweeper cadence ≈ 6 minutes maximum.
- **Vercel does not have a self-cleanup primitive equivalent to Cloudflare Cron Triggers:** Vercel cleanup requires a separate process. To prevent silently-leaky multi-host deployments, `createVercelAdapter` requires `config.multiHostMode: "single-host" | "multi-host-with-sweeper"` (no default — operators must choose):
  - `"single-host"`: adapter writes a single-host marker to the SQLite ledger AND uses an OS file lock (`flock` on `/var/lock/koi-sandbox-vercel.lock` or equivalent) to prevent any concurrent process on the same host from running another adapter. Two adapters on the same host fail-fast; multi-host operators see the next mode below.
  - `"multi-host-with-sweeper"`: adapter checks for a recent (`< 5 minutes`) sweeper heartbeat **stored in Vercel KV** (the same KV used for dedupe), NOT in the local SQLite ledger. The sweeper writes a key `koi:sweeper:heartbeat:${ownerId}` with a 90-second TTL every 60 seconds. Any host can read this key — it is provider-visible cross-host coordination, exactly the channel this mode requires.
    - **Heartbeat check is continuous, NOT one-shot at create time.** The adapter polls `GET koi:sweeper:heartbeat:${ownerId}` at construction, on every `create()`, AND on a 60-second background timer for the lifetime of the adapter object. Each existing `EdgeFunctionInstance` registers itself against the adapter's heartbeat watcher.
    - On adapter `create()` (and at construction): if the key is missing or stale, adapter fails with `KoiError { code: "SWEEPER_NOT_RUNNING" }` and refuses to deploy any artifact.
    - **Sweeper-loss handling for already-running instances:** if the background poller observes the heartbeat absent or stale for **3 consecutive checks (≈3 minutes)**, every still-active `EdgeFunctionInstance` registered against this adapter transitions to **POISONED**. Subsequent `invoke()` calls fail-closed with `KoiError { code: "SWEEPER_LOST" }`; only `destroy()` is permitted. This forces the operator to either restart the sweeper (whereupon the next `create()` succeeds) or call `destroy()` to clean up. There is no quiet path where instances keep accepting work without an active multi-host cleanup backstop.
    - **Why poison rather than continue serving:** the multi-host mode's only cleanup mechanism for a host crash IS the sweeper. Without it, a host crash mid-`invoke()` leaks the deployment indefinitely (Vercel has no provider-side TTL). Failing closed when the backstop disappears is the design's only safe choice.
    - **Adversarial test (mandatory):** `__tests__/vercel-sweeper-loss.test.ts` starts an adapter in `multi-host-with-sweeper` mode, creates an instance, then deletes the heartbeat key. Asserts (a) `invoke()` calls succeed for the first 2 minutes (within tolerance), (b) after ~3 minutes the instance is POISONED and `invoke()` rejects with `SWEEPER_LOST`, (c) `destroy()` still succeeds.
    - The sweeper's first action on startup is to write the heartbeat, so once running it satisfies this check immediately for all hosts.
    - Operators MUST run `@koi/sandbox-sweep --watch --vercel` (anywhere in the fleet, just one running instance is enough) before any Vercel adapter can construct in this mode AND for the lifetime of every adapter.
- Operators that try to use Vercel multi-host without a sweeper get a hard failure at adapter construction, not a silent leak.
  Artifacts created outside this adapter (or by other tools) lack these tags and are NEVER touched by sweep.
- **External reconciliation (only sweeps stale artifacts):** the cron job lists scripts/deployments where:
  - `koi-managed=v1` AND
  - `koi-owner=${expectedOwnerId}` AND
  - `koi-stale-after` is in the past (artifact's lease has expired).
  It then deletes them. Long-lived active instances renew their lease and are never swept regardless of age. The 1-hour threshold is replaced by the `koi-stale-after` lease check: sweep is gated on durable provider-side staleness, not just elapsed time.
  - The sweep additionally consults the local SQLite ledger to skip rows with `last_tried_at` within 5 minutes (some other host is actively reconciling).
- **Lease parameters tuned for control-plane outage tolerance:** the lease window (15 minutes) and the renewal cadence (every 2 minutes) are deliberately set so transient control-plane outages cannot cause the sweeper to kill healthy artifacts:
  - The host attempts a PATCH renewal every 2 minutes with a 30-second timeout.
  - A SINGLE missed renewal does NOT poison or sweep. Up to 3 consecutive failures over ~6 minutes are tolerated. After 3 consecutive misses, the host marks the local handle as POISONED and stops accepting new invokes (defense in depth — at this point control plane has been down for many minutes and the artifact's reachability is suspect anyway).
  - **Worker-originated liveness signal — Cloudflare only:** on Cloudflare, Worker A writes a `worker-alive` heartbeat to a DO storage key `${ownerId}:alive:${pairUUID}` with a 90-second TTL refreshed every 30 seconds via the DO `setAlarm` API. Cloudflare DO Alarms are a documented per-DO scheduled-execution primitive (no public URL needed). The fleet sweeper, before deleting any CF artifact, reads this key — if fresh, sweeper skips regardless of host-side `koi-stale-after`. This eliminates the false-kill case for Cloudflare: a control-plane outage that prevents host PATCH calls does not prevent Worker A's DO from continuing to alarm-trigger and refresh its liveness key.
  - **Vercel: no worker-originated liveness signal.** Vercel's only scheduling primitive is project-level cron jobs (1-minute minimum, hits a production URL — not a per-deployment internal scheduler). An ephemeral per-instance Worker B with `workers_dev: false` cannot host a cron, and even a cron in Worker A would have to invoke B over the public URL it intentionally lacks. We therefore do **not** claim a worker-originated heartbeat for Vercel. Vercel sweeper safety relies on **two compensating controls instead**:
    1. **Wider lease and slower sweep cadence:** Vercel's `koi-stale-after` lease window is **30 minutes** (vs. 5 minutes on CF), and the host-side renewal cadence is every 5 minutes with a 30-second timeout. Up to 5 consecutive renewal failures (~25 minutes) are tolerated before the local handle poisons. The Vercel sweeper runs every **2 minutes** (vs. 1 minute on CF) and only deletes artifacts whose `koi-stale-after` is past by an additional 5-minute grace. Net: a control-plane outage shorter than ~25 minutes never produces a false delete.
    2. **Sweeper itself runs in the koi sweep CLI**, not inside an ephemeral Vercel deployment. The CLI is on operator-managed infrastructure (or on a long-lived Vercel deployment of `@koi/sandbox-sweep` deployed once per fleet — that deployment IS allowed to use a Vercel cron). Operators choose where to run it; in `multi-host-with-sweeper` mode the heartbeat-loss circuit-break (already specified) ensures any extended outage of the sweeper poisons all running instances rather than silently leaking.
  - **Documented residual false-delete risk on Vercel:** if the Vercel control plane is unreachable for the entire 25-minute renewal-tolerance window AND the sweeper is reachable simultaneously, the sweeper may delete healthy artifacts. This is acknowledged in `docs/L2/sandbox-vercel.md` as a residual risk specific to Vercel's lack of per-instance scheduled execution. The `assertIdempotent: true` workload restriction means the caller has accepted that the next retry produces the correct outcome.
  - **Cross-host leak window** (worst case, both host PATCH outage AND control plane down): Cloudflare ≈ 16 minutes (5-minute lease + DO-alarm liveness backstop catches false-kills). Vercel ≈ 35 minutes (30-minute lease + 5-minute grace, no liveness backstop, residual false-kill risk acknowledged). Normal operation: 6 minutes (CF), 35 minutes (Vercel — slower by design).
- **Adversarial test (mandatory):** `__tests__/sweep-control-plane-outage.test.ts` simulates a Cloudflare/Vercel control-plane API outage where host PATCH calls fail 503 for 10 minutes while the worker continues to serve invokes (worker-alive heartbeat stays fresh). Asserts the sweeper does NOT delete the artifact during the outage, and that invokes continue to succeed. CI runs this on every PR that touches lease/sweep code.
- **Tag-application failure is a create failure:** if the provider does not accept the tags during deploy (older API, plan limitation), `create()` returns `KoiError { code: "TAGS_UNSUPPORTED" }` and tears down. We refuse to deploy untracked artifacts.
- **Synchronous cleanup option:** for callers that cannot tolerate any deferred cleanup, config exposes `synchronousCreateCleanup: boolean` (default `false`). When `true`, the adapter does not return until either (a) the cleanup DELETE returns confirmed-deleted (success path), or (b) cleanup fails and the orphan is persisted to the ledger. INDETERMINATE results are never returned with a still-pending in-process re-verify scheduled — the caller blocks until the durable trace is written. This trades latency for an absolute guarantee that no artifact exists outside the ledger.
- **Idempotent retries are caller responsibility:** the adapter never auto-retries `create`. Each retry produces a new UUID and is independent.
- **No orphan from successful create then later failure:** once `ready`, only `destroy()` deletes; failures during `exec()` poison but do not auto-delete (caller decides).
- Endpoint: `https://api.cloudflare.com/client/v4/accounts/{accountId}/workers/scripts/{instanceScriptName}` for deploy/delete; deployed worker URL for invoke.
- Network: only `fetch` — no SDK dep.
- Instance (`EdgeFunctionInstance`):
  - Owns its own `scriptName` for Worker A (gateway) AND companion `scriptName` for Worker B (handler runner) — both private fields, set at create time, never reused.
  - `invoke(req)` posts `{ payload, operationId, requestId, timeoutMs }` to **Worker A's** URL only (the gateway is the public surface). Worker A internally invokes Worker B via Service Binding (CF) or signed inter-deployment fetch (Vercel). The host adapter never talks directly to Worker B.
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
- **Mandatory host-side timeout:** `invoke()` enforces a non-optional default `timeoutMs` of 30_000 (capped by profile `resources.timeoutMs`). The caller cannot opt out. This guarantees the in-flight `fetch` cannot wait forever even if `destroy()` were not called.

**Honest contract — `destroy()` returns `DestroyOutcome`, not bare `void`:**

Cloudflare and Vercel offer no authoritative provider-side per-invocation kill confirmation. DELETE removes routing for new requests but cannot prove an already-running invocation has stopped. We refuse to lie about that:

```ts
export type DestroyOutcome =
  | { readonly kind: "destroyed-clean" }                          // local + remote DELETE confirmed; no in-flight invoke at start
  | { readonly kind: "destroyed-local-remote-indeterminate"; readonly inflightAtDestroy: number }
  | { readonly kind: "destroyed-local-remote-leaked"; readonly providerArtifacts: readonly string[]; readonly cause: KoiError }
  | { readonly kind: "destroyed-local-remote-uncertain"; readonly providerArtifacts: readonly string[]; readonly cause: KoiError };

// EdgeFunctionInstance.destroy returns Result so the contract surfaces failures explicitly:
readonly destroy: () => Promise<Result<DestroyOutcome, KoiError>>;
```

- `destroyed-clean`: no `invoke()` was in flight; remote DELETE returned 200/204 (or 404 confirmed by follow-up GET). Local handle gone, no possible residual side effects.
- `destroyed-local-remote-indeterminate`: at least one `invoke()` was active when destroy fired; remote DELETE confirmed but in-flight remote work may still complete. Inflight count reported.
- `destroyed-local-remote-leaked`: at least one of the two paired DELETEs (Worker A or Worker B) returned a definitive failure status. The local handle is gone, but at least one provider artifact is **known to still exist**. The list of leaked artifact identifiers is in `providerArtifacts: readonly string[]` (always carries both names if both leaked, the leaked one if only one failed). **Write-before-return invariant:** orphan rows for ALL leaked artifacts are persisted to the SQLite ledger with `synchronous=FULL` and `wal_checkpoint(FULL)` BEFORE this outcome is returned. If the ledger write itself fails, `destroy()` returns `Result.err(KoiError { code: "ORPHAN_LEDGER_WRITE_FAILED" })` instead of a `DestroyOutcome`, mirroring the create-failure path.
- `destroyed-local-remote-uncertain`: at least one DELETE call timed out or errored before any response. Whether the artifacts exist is unknown. Same write-before-return invariant; `providerArtifacts` lists every artifact whose state is uncertain.

**Crash-recovery test (mandatory):** `__tests__/destroy-leak-crash.test.ts` simulates a hard crash by spawning a subprocess that calls `destroy()` against a stub provider returning a 5xx for both paired artifacts, blocks just before return, then is killed with `SIGKILL`. The parent reopens the database and asserts BOTH orphan rows are present (one per artifact in the pair). CI runs this on every PR that touches the destroy path.
- `Result.err`: the destroy attempt itself failed before any cleanup could be attempted (e.g., the local mutex was poisoned by a prior bug). This is the only path where the local handle MIGHT still be holding state. Documented as "should not happen in normal operation"; if observed, the instance is in an inconsistent state and the caller should log and exit.

Callers MUST read the result:
- `Result.err` → unrecoverable instance bug; log + escalate.
- `destroyed-clean` → fully safe to discard.
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
| `timeoutMs` | mapped + host-enforced | Passed in body as `body.timeoutMs` and used for host `AbortController`. Capped by profile `resources.timeoutMs` and by the mandatory 30_000ms default. |
| `signal` (`AbortSignal`) | bridged-locally + remote-cancel | (a) Local: abort the host `fetch` so the caller's promise rejects on schedule. (b) Remote: when signal fires OR `timeoutMs` elapses, fire-and-forget POST to `/cancel` with `requestId` so the shim can correlate. The shim implements `/cancel` by aborting in-flight work it controls. |

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
- **Downstream idempotency at side-effect targets is REQUIRED (not recommended).** The adapter's durable dedupe store handles the happy path AND most failure paths, but several documented failure paths still allow handler effects to commit before the operation is durably retried:
  - Cloudflare DO `complete` retry exhaustion (`DEDUPE_PERSISTENCE_FAILED` after 3 attempts).
  - Vercel KV lease loss mid-handler (`LEASE_LOST`) and ownership loss at commit (`OWNERSHIP_LOST`).
  - Result exceeds `MAX_DEDUPE_RESULT_BYTES` after handler commit.
  In every case the handler's external side effects already happened, the next retry will re-run the handler, and the only remaining defense is downstream idempotency keyed on `operationId`. **The contract therefore mandates** that operators implement downstream idempotency at every side-effect target the handler touches — keyed on `operationId`. This is documented as a hard requirement in `docs/L2/sandbox-cloudflare.md` and `sandbox-vercel.md`, and the `assertIdempotent: true` flag's documentation explicitly includes "I have implemented downstream idempotency at every side-effect target keyed on `operationId`" as part of the operator's certification. **`requestId` MUST NOT be used for any dedupe purpose** — neither the durable store nor the downstream target should key on it.
- The shim caches entries for **300 seconds** after the original invocation completes (or fails). Expiration is wall-clock; entries are pruned lazily on each invoke.
- On `POST /invoke` arrival, the shim looks up the composite key `(operationId, requestId)`:
  - **Unknown composite key:** execute the handler, store result keyed on `(operationId, requestId)`, return it.
  - **Known composite key, in-flight:** the second request awaits the first's outcome (same Promise) and returns the same response. Two callers using the SAME `(operationId, requestId)` pair see the same result; the handler runs exactly once.
  - **Known composite key, completed:** return the cached result without re-running the handler.
  - **`requestId` reused with a DIFFERENT `operationId`:** treated as a fresh, unrelated invocation. The shim does NOT alias the new request to the cached entry — the lookup misses because the composite key differs. This prevents a caller bug (accidentally regenerating `operationId` while reusing a stale `requestId`, or vice versa) from returning one operation's result to a different operation. Defense-in-depth against caller misuse.
- **`requestId` is mandatory at the API boundary — no implicit generation.** The host-side `invoke()` rejects requests without `requestId` with `KoiError { code: "MISSING_REQUEST_ID" }` before any fetch. There is no auto-gen path. Rationale: callers who need to retry after timeout/abort/destroy MUST be able to reuse the same token on the retry; auto-generating the ID inside `invoke()` makes the original token unreachable to the caller (it lives in already-discarded request state), so retries necessarily carry a fresh UUID and the dedupe is useless on the exact failure paths it exists to mitigate.
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
| `network.allow = true` | accept | Workers always allow egress fetch. |
| `network.allow = false` | **REJECT** | CF does not expose a network-disable knob; cannot enforce → refuse. |
| `resources.maxMemoryMb` | accept iff `<= 128` | CF Workers cap. Reject above. |
| `resources.timeoutMs` | accept iff `<= 30_000` | CF Workers Unbound CPU limit. Reject above. |
| `resources.maxPids` | accept iff `=== 1` or omitted | Workers run a single isolate; multi-process not available. Reject `> 1`. |
| `resources.maxOpenFiles` | accept (vacuously) | No host FDs in Workers. |
| `env` | mapped | Forwarded as Worker secrets via `PUT /workers/scripts/{name}/secrets` per key (typed) **after** the deploy step succeeds and **before** the instance transitions to `ready` (see Create-failure state machine — secrets-uploading phase). The instance does NOT accept `invoke()` calls until `ready`; the host-side mutex is held in `secrets-uploading` so any concurrent invoke attempt waits or fails the create flow. |
| `nexusMounts` | REJECT | Requires FUSE; not available on edge. |
| `ssh` | **ignore** | Per `SandboxProfile.ssh` doc comment: "Other adapters MUST ignore this field." Treating it as a validation error would break profile portability when a profile carries an SSH stanza for a different backend. |
| `required` (capabilities) | **enforced by adapter** (and additionally by router) | The adapter calls `validateRequiredCapabilities(profile.required, SUPPORTED)` at the top of `create()` and rejects unsupported capabilities with `UNSUPPORTED_PROFILE` before any remote call. The router does the same upstream as a fast-path; the adapter never assumes the router pre-filtered. Single source of safety for direct callers. |
| Unknown future fields | REJECT (default-deny) | TypeScript catches at compile time; runtime exhaustive check guards against type-erasure bugs. |

Vercel applies the same template, but since runtime selection is deferred (see Out of scope) and the adapter always deploys to **Edge**, validation caps are **Edge-only**: `maxMemoryMb <= 128` and `timeoutMs <= 30_000`. Serverless caps (3008MB / 900_000ms) are NOT accepted — admitting them would let the router commit to this backend with a profile the actual runtime cannot satisfy. When a follow-up PR adds runtime selection, the adapter will accept a `runtime: "edge" | "serverless"` config field and validate against that runtime's caps.

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
  env: "mapped",
  nexusMounts: "reject",
  required: "validate-empty-only",
  ssh: "ignore",
} as const satisfies Record<keyof SandboxProfile, string>;
```

If a future PR adds a new top-level key to `SandboxProfile` without updating this const, TypeScript fails compilation with `Property '<newField>' is missing in type ...`. The cloud package will not build. This is a hard gate, not a runtime test.

Each subfield (filesystem.*, network.*, resources.*) gets its own `satisfies`-keyed const using `keyof FilesystemPolicy`, `keyof NetworkPolicy`, `keyof ResourceLimits` for the same exhaustiveness guarantee at compile time.

### `@koi/sandbox-vercel` (~350 LOC src + tests)

Mirrors cloudflare's per-instance isolation pattern:

- Endpoint: `https://api.vercel.com/v13/deployments` (create), `/v13/deployments/{id}` (delete).
- Auth: `vercelToken` + `teamId?` from config.
- **Per-instance deployment:** each `create()` produces a fresh deployment with its own `id` returned by Vercel. Instance owns the `id` and only deletes that id in `destroy()`. Concurrent creates cannot collide because Vercel allocates ids server-side.
- `destroy()` is idempotent — 404 on re-destroy treated as success.
- Function shim ≤80 LOC, same protocol as CF shim: `POST /invoke` (single endpoint) + `POST /cancel`. There is no `/exec`, `/read`, or `/write` — the wire protocol matches the `invoke()`-only contract exactly. A negative test in the cloud unit suites asserts that a `POST /exec` against the deployed shim returns 404, proving the deprecated surface does not exist.

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
| `sandbox-vercel` | Edge-specific | Same as cloudflare | Same as cloudflare |

`scripts/check-golden-queries.ts` enforces the split:

- A package with `koi.adapter-kind: "sandbox"` (wasm) MUST land assertions in `golden-replay.test.ts`.
- A package with `koi.adapter-kind: "edge-cloudflare"` or `"edge-vercel"` MUST land assertions in `golden-edge-replay.test.ts`.
- A package landing in the wrong replay test is a CI failure.

Cloud golden queries use a mocked `fetch` (injected via the adapter's `client` config field) so replays are hermetic and no real provider tokens are needed in CI. The wasm golden query runs a real WebAssembly module in-process with no external dependencies.

## CI gates (must pass)

- [ ] `bun run typecheck` — strict TS6 across new packages
- [ ] `bun run lint` — Biome
- [ ] `bun run check:layers` — L2-only deps (`@koi/core` + L0u only)
- [ ] `bun run check:orphans` — all 3 packages wired into `@koi/runtime`
- [ ] `bun run check:golden-queries` — 3 new queries land assertions
- [ ] `bun run check:duplicates` — accept 5+ line cloud duplication only if Rule-of-Three justified inline
- [ ] `bun run test` — coverage ≥80%
- [ ] `provider-smoke.yml` — required workflow; blocks merge on cleanup failure or leaked artifacts

## Docs (Doc → Tests → Code)

Write before code:

- `docs/L2/sandbox-wasm.md`
- `docs/L2/sandbox-cloudflare.md`
- `docs/L2/sandbox-vercel.md`

Each follows existing `docs/L2/sandbox-*.md` template: purpose, contract, config, capabilities, threat model, tests.

## Threat model

- **wasm:** in-process. Memory cap enforced by `WebAssembly.Memory({ maximum })`. CPU cap = wall-clock timeout (no instruction-count metering — `AbortSignal` only). No filesystem or network unless host imports are explicitly provided. Default config: zero host imports.
- **cloudflare/vercel:** remote. API tokens are secrets — validated for shape, never logged, never returned in errors. SSRF: deploy endpoint is hardcoded, invoke endpoint is pinned to provider-owned subdomains (`*.workers.dev`, `*.vercel.app`) — custom domains are out of scope. **`destroy()` does NOT guarantee remote cleanup succeeded**: the local handle is terminated reliably, but the remote artifacts may be `leaked` or `uncertain`, in which case `DestroyOutcome` reports the artifact identifiers and the orphan ledger plus tagged sweeper handle eventual cleanup. Operators MUST treat `destroyed-local-remote-leaked` and `destroyed-local-remote-uncertain` outcomes as **active cleanup incidents requiring follow-up**, not as successful teardown. Billing exposure and live-code exposure are bounded by the lease/sweep window (~5-6 minutes for Cloudflare via cron, sweeper cadence for Vercel), not by the synchronous `destroy()` call. The L2 docs require operators to set up alerting on non-clean destroy outcomes.

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
| 1 | This spec | Design doc (`docs/superpowers/specs/2026-05-05-edge-sandboxes-design.md`). No code, no doc reconciliation. | ~600 lines markdown |
| 2 | Kernel + runtime extension for edge adapters | New `@koi/core` types (`EdgeFunctionAdapter` etc.), `CreateKoiOptions` extension on `@koi/engine`, `koi.edge.*` accessor, CI script extensions for `koi.adapter-kind`, `docs/L3/sandbox-stack.md` rewrite, `golden-edge-replay.test.ts` skeleton. **Reconciles existing L3 doc with the new contract.** | ~700 LOC |
| 3 | `@koi/sandbox-wasm` | Full wasm executor package + binary scanner + tests + `docs/L2/sandbox-wasm.md` + golden replay assertion (uses the SandboxExecutor-style cassette path or the new edge replay; finalized in PR 2). | ~700 LOC |
| 4 | `@koi/sandbox-cloudflare` + `@koi/sandbox-vercel` + `@koi/sandbox-sweep` (single delivery unit) | Both cloud packages PLUS the cross-host sweeper janitor — they ship together because the cloud adapters' multi-host safety contract depends on the sweeper running. Includes shim templates with mandatory KV/EdgeConfig dedupe enforcement, SQLite ledger, provider-smoke workflow with adversarial scenarios, three L2 docs (`sandbox-cloudflare.md`, `sandbox-vercel.md`, `sandbox-sweep.md`), edge cassettes, and the sweeper CLI. | ~1300 LOC |

PRs 3 and 4 can land in parallel after PR 2 merges. PR 4 ships the sweeper as part of the same delivery unit so the multi-host safety contract is honored from day one — the cloud adapters never reach `main` without the cross-host cleanup mechanism they depend on.

## Acceptance

### PR 1 (this branch — design spec)

- [x] Design spec committed to `docs/superpowers/specs/`
- [x] Adversarial review converged (multiple Codex passes)
- [ ] User approval to proceed to PR 2

### PR 2 (kernel + runtime extension)

- [ ] New `@koi/core/edge-function-adapter.ts` lands with the documented type set
- [ ] `CreateKoiOptions` extended with `sandbox?` and `edgeAdapters?` fields
- [ ] `koi.edge.{cloudflare,vercel}` accessor reachable when populated, typed `undefined` when not
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

### PR 4 (`@koi/sandbox-cloudflare` + `@koi/sandbox-vercel`)

- [ ] Both packages compile, lint, typecheck under TS6 strict
- [ ] Unit tests pass with ≥80% coverage including failure paths (poison-on-timeout, mid-create failure, ledger crash recovery, dedupe under retry)
- [ ] Layer check green for both
- [ ] Orphan check green for both
- [ ] Golden edge replay covers both packages with cassettes
- [ ] `provider-smoke.yml` green: happy path + 4 adversarial scenarios + leak sweep
- [ ] `docs/L2/sandbox-cloudflare.md` and `sandbox-vercel.md` committed, including "Single-host vs multi-host orphan handling" sections and the `assertIdempotent` workload-class restriction
- [ ] `@koi/sandbox-sweep` package + `koi-sandbox-sweep --watch` CLI ship in the same PR
- [ ] Sweep smoke test: deploy 3 stub artifacts, expire 1 lease, run sweep, assert exactly the expired artifact is deleted
- [ ] L2 doc `docs/L2/sandbox-sweep.md` covering operator deployment patterns ships in this PR
- [ ] PR < 1500 LOC. If the bundle exceeds the budget, split as: 4a (`sandbox-cloudflare` + `sandbox-sweep` for Cloudflare) and 4b (`sandbox-vercel` + Vercel sweep extension). Vercel sweep cannot ship without the Vercel adapter; the Cloudflare bundle is independent.
