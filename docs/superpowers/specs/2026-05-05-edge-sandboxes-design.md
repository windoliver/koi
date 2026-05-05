# Edge Sandboxes Design (issue #1377)

**Date:** 2026-05-05
**Issue:** [#1377](https://github.com/windoliver/koi/issues/1377) — v2 Phase 3-sandbox-3
**Branch:** `feat/issue-1377-edge-sandboxes`

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
  readonly destroy: () => Promise<DestroyOutcome>;  // see Cancellation honesty below
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
- **Per-instance script naming:** every `create()` call deploys to a unique script name `${configPrefix}-${randomUUID()}` (e.g., `koi-sandbox-7f3a...`). Config supplies an optional `scriptPrefix` (default `koi-sandbox`); the random suffix is owned by the instance. Two concurrent `create()` calls cannot collide, and `destroy()` only deletes the instance's own script.

#### Create-failure state machine (orphan-safe)

Remote create involves multiple sequential mutations: (1) `PUT /workers/scripts/{name}` (deploy bytes), (2) optional per-key `PUT /workers/scripts/{name}/secrets` (env vars from profile), (3) optional route binding. Any of these can fail mid-way.

States:

```
allocating → deploying → secrets-uploading → bound → ready
       \         \              \                \
        \         \              \                +--> create failure → cleanup
         \         \              +-------------------> create failure → cleanup
          \         +--------------------------------> create failure → cleanup
           +-------------------------------------------> no remote artifact yet
```

Rules:

- **Bounded create timeout:** `createTimeoutMs` (default 30_000) wraps the entire create flow. On timeout, transition to `create failure`.
- **Best-effort delete:** on any create failure after the deploy step has been issued (i.e., a script with the per-attempt `name` may exist), the adapter unconditionally fires `DELETE /workers/scripts/{name}` regardless of which step failed. This is fire-and-forget with its own short timeout (`cleanupTimeoutMs`, default 5_000).
- **Cleanup confirmation (control-plane race aware):**
  - The adapter tracks `deployStartedAt` for each create attempt. The cleanup DELETE result is interpreted relative to whether deploy is known to have completed:
    - **Deploy fully completed before failure** (e.g., failure during step 2 secrets-upload, after step 1 returned 200): cleanup `200` / `204` = `cleanedUp: true`. `404` is also accepted because the script existed and is now gone. Return `CREATE_FAILED { cleanedUp: true }`.
    - **Deploy did NOT complete or is in flight when failure was detected** (e.g., create timeout fired during step 1, or step 1 returned a non-success status): a `404` from cleanup is **NOT** proof of deletion — the deploy can still materialize after the control-plane returned `404`. In this race window, return `CREATE_FAILED_INDETERMINATE { scriptName, cleanedUp: false }` even on `404`. Operator/janitor must verify by re-listing scripts after a delay.
    - Any other status, timeout, or network error: `CREATE_FAILED_INDETERMINATE { scriptName, cleanedUp: false, cause }` regardless of phase.
  - The adapter schedules a **delayed re-verify**: 60 seconds after an INDETERMINATE result it re-issues `GET /workers/scripts/{name}` and, if the script now exists (the racing deploy materialized), fires a final DELETE.

#### Durable orphan tracking (survives process crashes)

In-process delayed re-verify is necessary but not sufficient: a host crash, container restart, or kill-9 between detecting the failure and completing cleanup leaves a billable artifact behind. The adapter therefore persists pending orphans **durably** before declaring an INDETERMINATE result:

- **Orphan ledger storage — SQLite, not a JSON file:** `${config.orphanLedgerPath ?? "${HOME}/.koi/sandbox-orphans.db"}` — a `bun:sqlite` database. JSON files are unsafe under concurrent writers (multi-process or multi-host hosts re-running the adapter): two failing creates can read the same snapshot, each rewrite, and the last rename wins. SQLite gives us proper transactional read-modify-write with row-level mutation safety inside a single process, and `BEGIN IMMEDIATE` + WAL mode handles cross-process contention via the OS-level lock SQLite already implements.
- **Schema (one table, two row variants discriminated by `provider`):**
  ```sql
  CREATE TABLE IF NOT EXISTS orphans (
    id TEXT PRIMARY KEY,                -- provider:scope:resource-id (deterministic; see below)
    provider TEXT NOT NULL,             -- "cloudflare" | "vercel"
    account_id TEXT,                    -- Cloudflare: required; Vercel: NULL
    team_id TEXT,                       -- Vercel: nullable; Cloudflare: NULL
    project_id TEXT,                    -- Vercel: required; Cloudflare: NULL
    script_name TEXT,                   -- Cloudflare: required
    deployment_id TEXT,                 -- Vercel: required
    deployment_url TEXT,                -- Vercel: required
    created_at TEXT NOT NULL,
    last_tried_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_orphans_provider_scope ON orphans (provider, account_id, team_id, project_id);
  ```
  `id` is `cloudflare:${accountId}:${scriptName}` or `vercel:${teamId ?? "_personal"}:${projectId}:${deploymentId}` — deterministic so re-inserting an already-known orphan is an UPSERT, not a duplicate.
- **Atomic operations:** all writes wrap `BEGIN IMMEDIATE; ... COMMIT;` so concurrent adapter instances cannot interleave. Reconciliation deletes a row in the same transaction that confirms the provider DELETE returned success — no read-then-delete window.
- **WAL mode + fsync per transaction:** `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;` provides crash safety across host restarts (the WAL is replayed on reopen). For the create-failure path that requires durable persistence before returning, the adapter additionally calls `db.exec("PRAGMA wal_checkpoint(TRUNCATE)")` to force WAL flush before reporting INDETERMINATE — this guarantees the orphan survives even an immediate `kill -9`.
- **Write-before-return invariant:** an INDETERMINATE result is only returned to the caller AFTER the orphan has been persisted to the ledger. If the ledger write itself fails, the adapter blocks and retries (bounded) before returning a strictly-stronger error `KoiError { code: "ORPHAN_LEDGER_WRITE_FAILED" }` with the artifact identity in context. Caller knows operator intervention is required immediately.
- **Reconciliation on adapter init:** at construction time, each adapter reads the ledger and matches entries by its provider-specific ownership key:
  - Cloudflare: `provider === "cloudflare" && accountId === config.accountId`.
  - Vercel: `provider === "vercel" && (teamId ?? null) === (config.teamId ?? null) && projectId === config.projectId`.
  Each matched orphan triggers a provider-specific DELETE (`/workers/scripts/{scriptName}` for CF, `/v13/deployments/{deploymentId}` for Vercel). Successful deletions (or 404 confirmed by a follow-up GET) remove the entry; failures bump `lastTriedAt` and stay queued. The Vercel adapter requires `projectId` in its config so reconciliation has a deterministic key — it is not optional.
- **External reconciliation:** the `provider-smoke.yml` nightly cron job lists ALL scripts/deployments older than 1 hour, regardless of prefix, that the configured token has authority to delete. The configurable `scriptPrefix` defaults to `koi-sandbox` but is not relied on for sweeping — operators can override prefix without losing janitor coverage. The sweep cross-references the SQLite ledger to skip artifacts the local process is still actively managing (rows with `last_tried_at` within 5 minutes), and deletes everything else. This is the cross-host backstop independent of any prefix convention; the local SQLite ledger is the single-host transactional backstop.
- **Synchronous cleanup option:** for callers that cannot tolerate any deferred cleanup, config exposes `synchronousCreateCleanup: boolean` (default `false`). When `true`, the adapter does not return until either (a) the cleanup DELETE returns confirmed-deleted (success path), or (b) cleanup fails and the orphan is persisted to the ledger. INDETERMINATE results are never returned with a still-pending in-process re-verify scheduled — the caller blocks until the durable trace is written. This trades latency for an absolute guarantee that no artifact exists outside the ledger.
- **Idempotent retries are caller responsibility:** the adapter never auto-retries `create`. Each retry produces a new UUID and is independent.
- **No orphan from successful create then later failure:** once `ready`, only `destroy()` deletes; failures during `exec()` poison but do not auto-delete (caller decides).
- Endpoint: `https://api.cloudflare.com/client/v4/accounts/{accountId}/workers/scripts/{instanceScriptName}` for deploy/delete; deployed worker URL for invoke.
- Network: only `fetch` — no SDK dep.
- Instance (`EdgeFunctionInstance`):
  - Owns its own `scriptName` (private field, set at create time, never reused).
  - `invoke(req)` posts `{ payload, timeoutMs }` to its own worker URL → translates JSON response to `EdgeInvokeResult`. Only JSON-serializable input; the worker shim parses request, calls the deployed JS handler, returns `{ output, durationMs }`.
  - No `exec`, `spawn`, `readFile`, or `writeFile` methods exist on the type. Direct callers cannot accidentally invoke them — TypeScript catches at compile time. This is the value of the narrower contract.
  - `destroy()` → DELETE only this instance's script. Idempotent (404 on re-destroy is success).

#### Stateless contract — `create()` is fail-closed for unsupported profile shapes

The `EdgeFunctionInstance` surface (just `invoke` + `destroy`) is intentionally smaller than `SandboxInstance`, so most contract-mismatch issues vanish at the type level. Two checks remain at runtime:

- **Profile structural reject:** the profile mapping table (next section) rejects `filesystem.allowRead`/`filesystem.allowWrite` non-empty, `nexusMounts` non-empty, and `defaultReadAccess: "open"` before any remote call. A profile asking for filesystem-RW is refused at `create()`.
- **Capability requirement reject:** `create()` calls `validateRequiredCapabilities(profile.required, SUPPORTED)` where `SUPPORTED = Set(["exec"])` (best fit existing taxonomy for "run code and get output"). If `profile.required` demands any capability outside `SUPPORTED` (e.g., `"filesystem-rw"`, `"copy-files"`, `"persistence"`), return `KoiError { code: "UNSUPPORTED_PROFILE", required, supported }` before any remote work. This catches direct callers that bypass any router.
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
  | { readonly kind: "destroyed-clean" }                          // never had an in-flight invoke
  | { readonly kind: "destroyed-local-remote-indeterminate"; readonly inflightAtDestroy: number };
```

- `destroyed-clean`: no `invoke()` was in flight when `destroy()` was called. Local handle gone, no possible residual side effects.
- `destroyed-local-remote-indeterminate`: at least one `invoke()` was active. Local handle is gone, no future invokes possible, BUT in-flight remote work may still complete and produce side effects after `destroy()` returns. The number of affected invokes is reported.
- `EdgeFunctionInstance.destroy()` is typed `Promise<DestroyOutcome>` — not `Promise<void>`. Callers must read it. This forces the contract to be honest at the type level; idempotency considerations propagate to the caller's design.
- The threat model is updated accordingly: "destroy reliably terminates locally; remote completion of in-flight work is not preventable on these providers and callers must design `invoke()` payloads to be idempotent or carry a unique request token the caller can deduplicate at side-effect targets".

Caller-visible: `invoke()` is awaited as usual; the only behavioral change vs. an OS sandbox is that calls are not parallel within an instance. Callers that need parallelism create multiple instances. Calling `destroy()` while an `invoke()` is in flight rejects that invoke promptly — destroy is never blocked behind hung remote work — and the returned `DestroyOutcome` documents whether residual remote effects are possible.

This is documented prominently in `docs/L2/sandbox-cloudflare.md` and tested in unit suites (concurrent-invoke serialization, poison-after-timeout-rejects-queued, destroy-cancels-queued).

#### `EdgeInvokeRequest` field handling

`EdgeInvokeRequest` is intentionally minimal:

| Field | Disposition | Notes |
|-------|-------------|-------|
| `payload` | mapped | JSON-serialized into POST body |
| `timeoutMs` | mapped + host-enforced | Both passed in body and used for host AbortController. Capped by profile `resources.timeoutMs` and by the mandatory 30_000ms default. |
| `signal` (`AbortSignal`) | bridged-locally + remote-cancel | (a) Local: abort the host `fetch` so the caller's promise rejects on schedule. (b) Remote: when signal fires OR `timeoutMs` elapses, fire-and-forget POST to a `/cancel` endpoint on the worker. The shim implements `/cancel` by aborting in-flight work it controls. |

There is no `onStdout`/`onStderr` on `EdgeInvokeRequest` — streaming is not part of the contract, by design. Callers who need streaming use a different adapter.

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

#### Profile conformance tests

`packages/sandbox/sandbox-conformance` provides a profile-rejection harness. Each cloud package adds a conformance test that walks every documented profile field and asserts the accept/reject behavior above. A separate gate test imports `SandboxProfile` reflectively and fails if any top-level key is missing from the cloud mapping table — this prevents new core fields from landing without an explicit edge-adapter decision.

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
- Forks without secret access skip the gate; CODEOWNERS approval required for fork PRs that touch these paths.
- A nightly cron runs the same workflow against `main` to catch provider-side drift between merges.

### Golden queries (CI gate per CLAUDE.md)

Add three queries to `packages/meta/runtime/scripts/record-cassettes.ts`:

| Query | Coverage |
|-------|----------|
| `sandbox-wasm` | Tool invocation that uses `@koi/sandbox-wasm` to run a small wasm `add` |
| `sandbox-cloudflare` | Stubbed adapter (no live deploy in golden) — verifies wiring path through `createKoi` |
| `sandbox-vercel` | Same — wiring-only |

Cloud golden queries use a mocked `fetch` (injected via config) so replays are hermetic. Add corresponding assertions to `golden-replay.test.ts`.

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
- **cloudflare/vercel:** remote. API tokens are secrets — validated for shape, never logged, never returned in errors. SSRF: deploy endpoint is hardcoded, exec endpoint comes from CF/Vercel response — validate it's HTTPS and on the expected domain before invocation. Cleanup on `destroy()` MUST succeed before instance is considered destroyed (deleted scripts/deployments do not bill).

## Out of scope (deferred)

- WASI support (sandbox-wasm runs core WebAssembly only)
- Streaming output (no `onStdout`/`onStderr` on `EdgeInvokeRequest`; deferred until a future `EdgeFunctionStreamingAdapter` contract exists)
- KV / Durable Objects / Edge Config bindings (Cloudflare)
- Vercel Edge runtime vs Node runtime selection (defaults to Edge)
- `findOrCreate` persistence on cloud adapters (script reuse) — current PR creates fresh per `create()`

## Acceptance

- [ ] Three packages compile, lint, typecheck under TS6 strict
- [ ] All unit tests pass with ≥80% coverage
- [ ] Layer + orphan + golden-query CI gates green
- [ ] `provider-smoke.yml` green (cloud adapters: real create/invoke/destroy + leak check)
- [ ] Three `docs/L2/*.md` files committed
- [ ] PR < 1500 lines logic
