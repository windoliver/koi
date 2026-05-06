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

### Forbidden workload class — non-idempotent payloads

The duplicate-side-effect hazard introduced by timeout/abort/destroy + per-isolate dedupe is real and cannot be eliminated at the adapter layer with available provider primitives. Rather than ship a generic adapter that documents the hazard, the contract narrows the supported workload class:

- **`createCloudflareAdapter` and `createVercelAdapter` REQUIRE `config.assertIdempotent: true`.** This is a literal-true field, not a default. The adapter refuses to construct otherwise (returns `KoiError { code: "IDEMPOTENCY_NOT_ASSERTED" }`).
- Setting `assertIdempotent: true` is the operator's affirmation that every `payload` they pass to `invoke()` represents an idempotent operation: a retry with the same `requestId` AND a retry with a fresh `requestId` BOTH must produce the same observable side effect (or no additional side effect after the first). This includes downstream API calls, database writes, payments, and state transitions performed by the deployed JS handler.
- Mutating workloads (non-idempotent payments, sequence-dependent writes, etc.) are NOT supported by these adapters in this PR. Operators wanting them MUST either implement idempotency at the side-effect target before adopting the adapter OR wait for a future `sandbox-cloudflare-durable` package that backs dedupe with Durable Objects (out of scope here).
- The `assertIdempotent: true` literal lives in the orphan ledger metadata for the adapter and is also logged on every `create()` so audit trails can confirm operators consented to the workload-class restriction.

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
- **Per-instance script naming:** every `create()` call deploys to a unique script name `${configPrefix}-${randomUUID()}` (e.g., `koi-sandbox-7f3a...`). Config supplies an optional `scriptPrefix` (default `koi-sandbox`); the random suffix is owned by the instance. Two concurrent `create()` calls cannot collide, and `destroy()` only deletes the instance's own script.
- **Per-attempt client-side identity (Vercel-recovery key):** Vercel assigns `deploymentId` server-side, so a create timeout before the response returns can leave the host without an identity to use for cleanup. To make every create attempt independently recoverable, the adapter generates a per-attempt UUID `attemptId = randomUUID()` BEFORE issuing the deploy POST and writes it to deployment metadata: `meta = { ..., "koi-attempt-id": attemptId }`. On any create failure where the response did not return (timeout, network error, or unparseable response), the adapter calls `GET /v6/deployments?meta-koi-attempt-id=${attemptId}` to discover the `deploymentId` of the artifact (if it materialized) and uses it for the cleanup DELETE. The `attemptId` itself is recorded in the orphan ledger so a host crash before the `GET` resolves still leaves a deterministic recovery key — the next adapter to read the ledger can complete the lookup. Cloudflare uses the deterministic `scriptName` directly; Vercel uses the `attemptId` lookup as its equivalent.

#### Create-failure state machine (orphan-safe)

Remote create involves multiple sequential mutations. The order is chosen so that **a partially-created artifact is never reachable with secrets attached**:

1. `PUT /workers/scripts/{name}` with `workers_dev: false` and no custom route — deploy the bytes but with **zero reachability**. The worker exists but has no `*.workers.dev` URL and no custom hostname, so no external request can reach it.
2. (only if step 1 succeeded) `PUT /workers/scripts/{name}/secrets` per env-var key — uploads secrets onto an unreachable artifact. If create fails here, an attacker has no way to invoke the worker even if cleanup races leave it behind.
3. (only if step 2 succeeded) **Activation step**: `PATCH /workers/scripts/{name}/subdomain` to set `enabled: true`, OR bind a custom route. This is the single atomic step that makes the worker reachable. If activation fails, secrets are already attached but reachability was never granted.
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

**Per-instance shim authentication (mandatory bearer token):**

URL secrecy and provider-side protection are not enough on their own. Once a worker is activated, anyone who learns the URL — through logging, sharing, or provider-side enumeration — can hit `/invoke` and execute deployed code carrying its attached secrets. To close this gap, the adapter generates a per-instance authentication token at `create()` time and the shim enforces it on every request:

- During `create()`, the host generates `instanceToken = randomBytes(32).toString("base64url")` (256 bits). This token is uploaded as a Worker secret named `KOI_INSTANCE_TOKEN` during the secrets-uploading step (alongside any user-provided `env` secrets).
- The shim's request handler reads `KOI_INSTANCE_TOKEN` from its secrets and rejects any incoming request whose `Authorization: Bearer <token>` header does not match exactly. Constant-time comparison; 401 with no body on mismatch. Applies to `/invoke`, `/cancel`, every endpoint.
- The host-side `EdgeFunctionInstance` retains `instanceToken` in private state and includes the `Authorization: Bearer ${instanceToken}` header on every fetch. The token is never exposed in the public API surface and never logged.
- `destroy()` deletes the script (Cloudflare) or deployment (Vercel), which removes the token along with everything else. The token's lifetime is bounded by the instance lifetime.
- This is mandatory, not optional. The shim's request handler refuses to start if `KOI_INSTANCE_TOKEN` is unset (defense-in-depth against misconfigured deploys).
- For Vercel, the same token + same secret name + same enforcement applies. Vercel preview protection plus token auth is defense-in-depth: pre-activation, protection blocks anonymous access; post-activation, the token blocks anonymous access; both fail closed.

For Vercel, the analogous gate (for pre-activation reachability) requires **adapter-enforced deployment protection**, not an external account default:

- The adapter's `createVercelAdapter(config)` requires `config.projectId` and verifies via `GET /v9/projects/{projectId}` at construction time that the project has `ssoProtection.deploymentType` (or `passwordProtection.deploymentType`) set to `"all"` or `"prod_deployment_urls_and_all_previews"`. If protection is disabled or scoped narrower, `createVercelAdapter` returns `KoiError { code: "VERCEL_PROTECTION_REQUIRED", reason: "preview-protection-not-enforced" }` and refuses to construct.
- **Uncached re-check inside every `create()`:** project protection settings can drift after adapter construction (operator changes them on the dashboard). Each `create()` therefore re-issues the same `GET /v9/projects/{projectId}` check IMMEDIATELY before any deploy mutation, with **no caching of allow results**. Allow decisions are evaluated against fresh provider state on every create. The optional cache stores ONLY negative/terminal failures (e.g., `VERCEL_PROTECTION_REQUIRED`) for 30 seconds to short-circuit retries against a known-bad project; a positive `protection-enforced` result is never cached and never reused. This bounds API rate on the failure path while preserving the safety property on the allow path. If the live check shows protection has been disabled or scoped narrower, `create()` returns `VERCEL_PROTECTION_REQUIRED` and never deploys. The structural reachability invariant is therefore guarded both at adapter construction (for fast failure of misconfigured deployments) and at every create call with provider-fresh data (against post-construction drift).
- Each deployment is created with `target: "preview"` until activation, so it lands behind the protection gate. Activation either flips `target: "production"` (after secrets and protection are confirmed) or attaches a custom domain — both are explicit final-step transitions.
- Pre-activation, the preview URL is reachable only with a valid Vercel SSO/password token bound to that project. The koi adapter never publishes that URL externally; even if leaked, the protection gate stops anonymous invocation.
- The smoke workflow (`provider-smoke.yml`) includes a `vercel-protection-required` scenario: temporarily disable protection on the test project, attempt `createVercelAdapter`, assert it returns `VERCEL_PROTECTION_REQUIRED` and refuses to construct. Re-enable, assert success.

This makes Vercel's safety story adapter-enforced, not account-default-dependent.

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
  At create time `koi-stale-after = now + 24h`. While the instance is alive, the host-side adapter renews this tag every 12 hours via `PATCH /workers/scripts/{name}/tags` (CF) or `PATCH /v13/deployments/{id}/meta` (Vercel) — set to `now + 24h`. On `destroy()` the entire artifact is deleted. On host crash, the tag stops renewing and naturally expires; the sweep picks it up once `koi-stale-after` is in the past.
  Artifacts created outside this adapter (or by other tools) lack these tags and are NEVER touched by sweep.
- **External reconciliation (only sweeps stale artifacts):** the cron job lists scripts/deployments where:
  - `koi-managed=v1` AND
  - `koi-owner=${expectedOwnerId}` AND
  - `koi-stale-after` is in the past (artifact's lease has expired).
  It then deletes them. Long-lived active instances renew their lease and are never swept regardless of age. The 1-hour threshold is replaced by the `koi-stale-after` lease check: sweep is gated on durable provider-side staleness, not just elapsed time.
  - The sweep additionally consults the local SQLite ledger to skip rows with `last_tried_at` within 5 minutes (some other host is actively reconciling).
- **Lease renewal failure handling:** if the host fails to renew a lease (network error, expired token, etc.), the local adapter logs `LEASE_RENEWAL_FAILED` and increments a counter. After 3 consecutive failures over 30 minutes, the host considers the artifact lost and tears down the local handle (POISONED state) so callers stop sending invokes. The artifact then ages out via lease expiry as normal.
- **Tag-application failure is a create failure:** if the provider does not accept the tags during deploy (older API, plan limitation), `create()` returns `KoiError { code: "TAGS_UNSUPPORTED" }` and tears down. We refuse to deploy untracked artifacts.
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
  | { readonly kind: "destroyed-local-remote-leaked"; readonly providerArtifact: string; readonly cause: KoiError }
  | { readonly kind: "destroyed-local-remote-uncertain"; readonly providerArtifact: string; readonly cause: KoiError };

// EdgeFunctionInstance.destroy returns Result so the contract surfaces failures explicitly:
readonly destroy: () => Promise<Result<DestroyOutcome, KoiError>>;
```

- `destroyed-clean`: no `invoke()` was in flight; remote DELETE returned 200/204 (or 404 confirmed by follow-up GET). Local handle gone, no possible residual side effects.
- `destroyed-local-remote-indeterminate`: at least one `invoke()` was active when destroy fired; remote DELETE confirmed but in-flight remote work may still complete. Inflight count reported.
- `destroyed-local-remote-leaked`: remote DELETE returned a definitive failure status (e.g., 4xx for permission, 5xx persistent). The local handle is gone, but the provider artifact is **known to still exist**. The artifact identifier is in `providerArtifact` so the caller can trigger an out-of-band cleanup or alert. The orphan is also persisted to the SQLite ledger and surfaces in the next reconciliation pass.
- `destroyed-local-remote-uncertain`: the DELETE call timed out or errored before any response was received. Whether the artifact exists is unknown. Same orphan-ledger persistence as `leaked`. The follow-up reconciliation will determine state via `GET`.
- `Result.err`: the destroy attempt itself failed before any cleanup could be attempted (e.g., the local mutex was poisoned by a prior bug). This is the only path where the local handle MIGHT still be holding state. Documented as "should not happen in normal operation"; if observed, the instance is in an inconsistent state and the caller should log and exit.

Callers MUST read the result:
- `Result.err` → unrecoverable instance bug; log + escalate.
- `destroyed-clean` → fully safe to discard.
- `destroyed-local-remote-indeterminate` → safe to discard local handle; downstream side effects may still arrive (idempotency at side-effect targets handles this).
- `destroyed-local-remote-leaked` / `uncertain` → log the `providerArtifact` for operator visibility; the orphan is in the ledger. Optionally `await` the next reconciliation pass to confirm cleanup.
- The threat model is updated accordingly: "destroy reliably terminates locally; remote completion of in-flight work is not preventable on these providers and callers must design `invoke()` payloads to be idempotent or carry a unique request token the caller can deduplicate at side-effect targets".

Caller-visible: `invoke()` is awaited as usual; the only behavioral change vs. an OS sandbox is that calls are not parallel within an instance. Callers that need parallelism create multiple instances. Calling `destroy()` while an `invoke()` is in flight rejects that invoke promptly — destroy is never blocked behind hung remote work — and the returned `DestroyOutcome` documents whether residual remote effects are possible.

This is documented prominently in `docs/L2/sandbox-cloudflare.md` and tested in unit suites (concurrent-invoke serialization, poison-after-timeout-rejects-queued, destroy-cancels-queued).

#### `EdgeInvokeRequest` field handling

`EdgeInvokeRequest` is intentionally minimal:

| Field | Disposition | Notes |
|-------|-------------|-------|
| `payload` | mapped | JSON-serialized into POST body as `body.payload`. |
| `operationId` | mapped (mandatory) | JSON-serialized as `body.operationId` AND set as `X-Koi-Operation-Id` request header. Forwarded to the deployed handler in both forms — the handler reads from either. The shim does NOT use `operationId` for its own caching; it is downstream-correctness-only. |
| `requestId` | mapped (mandatory) | JSON-serialized as `body.requestId` AND set as `X-Koi-Request-Id` request header. The shim's in-memory dedupe cache is keyed on `requestId`. The handler MAY observe `requestId` for tracing but MUST NOT use it for downstream dedupe. |
| `timeoutMs` | mapped + host-enforced | Passed in body as `body.timeoutMs` and used for host `AbortController`. Capped by profile `resources.timeoutMs` and by the mandatory 30_000ms default. |
| `signal` (`AbortSignal`) | bridged-locally + remote-cancel | (a) Local: abort the host `fetch` so the caller's promise rejects on schedule. (b) Remote: when signal fires OR `timeoutMs` elapses, fire-and-forget POST to `/cancel` with `requestId` so the shim can correlate. The shim implements `/cancel` by aborting in-flight work it controls. |

`operationId` and `requestId` are sent as both body fields and headers for redundancy: middleware logging captures the headers without parsing JSON, and the shim's dedupe path reads the header without parsing the body. Both fields are validated as non-empty UUID-like strings before send; missing fields cause `KoiError { code: "MISSING_OPERATION_ID" | "MISSING_REQUEST_ID" }` before any fetch.

The shim's deployed-handler invocation is `handler({ payload, operationId, requestId })`. The handler signature is documented in `docs/L2/sandbox-cloudflare.md` so deployers know which key to use for downstream dedupe (`operationId` only).

There is no `onStdout`/`onStderr` on `EdgeInvokeRequest` — streaming is not part of the contract, by design. Callers who need streaming use a different adapter.

#### Two-tier idempotency (`operationId` for downstream, `requestId` for shim cache)

The contract distinguishes two distinct idempotency scopes — they are NOT the same key:

| Field | Lifetime | Owner | Purpose |
|-------|----------|-------|---------|
| `operationId` | Full logical operation, **persists across `destroy()` + new `create()` + multiple instances** | Caller (NEVER auto-generated) | Passed to deployed handler; the handler uses it as the dedupe/idempotency key against external side-effect targets (downstream APIs, databases). The handler MUST treat two requests with the same `operationId` as the same logical operation regardless of their `requestId`. |
| `requestId` | Single network attempt only — generate fresh on every retry | Caller (per-attempt; e.g., `crypto.randomUUID()` per `invoke()` call) | Per-isolate shim cache key. NOT a downstream-correctness mechanism; only a performance/duplicate-effect-reduction optimization for the case where the same isolate handles a retry within 300s. |

The previous spec passes used `requestId` for both purposes, which collapsed them and contradicted itself across the destroy/recreate boundary. The two-field model resolves this:

- A retry within the SAME instance with the SAME `operationId` and a FRESH `requestId` allows the shim cache to miss (different `requestId`) but downstream dedupe still works (same `operationId`). Caller saves nothing on the shim path but doesn't double-execute external side effects.
- A retry across `destroy()` + new `create()` carries the SAME `operationId` and a FRESH `requestId`. The shim cache is empty in the new instance but downstream dedupe still works. This is the recovery path the previous spec broke.
- A caller running multiple parallel attempts of the same operation (e.g., racing two instances) uses the same `operationId` for both — only one of their downstream effects commits.

#### Request-ID shim cache (best-effort dedupe — NOT exactly-once)

Because `destroy()` and timeout/abort can leave remote work in flight (see `DestroyOutcome`), **`requestId` is required, not optional, on every `invoke()`**. The shim deduplicates by ID — but with explicit honest limits:

- **The dedupe is a best-effort cache, not an exactly-once guarantee.** The shim caches `requestId → { status, result, expiresAt }` in a per-isolate in-memory `Map`. Cloudflare and Vercel do not pin retries to the same isolate; isolates can also be evicted at any time. Therefore a retry can land on a fresh isolate where the dedupe entry does not exist, and the handler runs again.
- **Contract claim:** the adapter does NOT promise exactly-once execution. The contract is "if the retry lands on the same warm isolate within the cache window, dedupe takes effect; otherwise the handler may run twice." This is documented at the top of `docs/L2/sandbox-cloudflare.md` and `sandbox-vercel.md` so callers cannot mistake the mechanism for a stronger guarantee.
- **Caller-side correctness requirement (downstream dedupe is keyed by `operationId` ONLY):** for any `invoke()` whose `payload` triggers non-idempotent side effects (external writes, payments, state mutations), the caller's deployed handler MUST implement idempotency at the side-effect boundary using **`operationId`** as the dedupe key — e.g., a unique constraint on the downstream database keyed on `operationId`, an idempotency-key header on the downstream API populated with `operationId`, or an in-application dedupe table indexed by `operationId`. **`requestId` MUST NOT be used for downstream dedupe** — it changes per attempt and across `destroy()`/`create()` boundaries, so keying downstream effects on it would make every retry look like a new operation and defeat the purpose. The shim cache (keyed on `requestId`) helps performance only; it is NOT a correctness mechanism.
- The shim caches entries for **300 seconds** after the original invocation completes (or fails). Expiration is wall-clock; entries are pruned lazily on each invoke.
- On `POST /invoke` arrival:
  - **Unknown ID:** execute the handler, store result, return it.
  - **Known ID, in-flight:** the second request awaits the first's outcome (same Promise) and returns the same response. Two callers using the same `requestId` see the same result; the handler runs exactly once.
  - **Known ID, completed:** return the cached result without re-running the handler.
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
- Cross-instance retries (after `destroy()` + new `create()`) cannot benefit from shim dedupe — the shim cache is per-isolate and a new instance is on a fresh script entirely. The recovery is `operationId`-driven at the side-effect target, not `requestId`-driven at the shim. This is the correct boundary: provider-side dedupe across instance recreation is impossible without durable cross-instance state (out of scope), so we push the cross-instance case to where it can actually be solved — the side-effect target where `operationId` is the dedupe key.
- The shim's per-isolate cache is bounded: max 1000 entries with LRU eviction. Above that, oldest entries are dropped, and a duplicate request for an evicted ID re-runs the handler. Operators tune this via deployed code if higher concurrency requires it.
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
- **cloudflare/vercel:** remote. API tokens are secrets — validated for shape, never logged, never returned in errors. SSRF: deploy endpoint is hardcoded, exec endpoint comes from CF/Vercel response — validate it's HTTPS and on the expected domain before invocation. Cleanup on `destroy()` MUST succeed before instance is considered destroyed (deleted scripts/deployments do not bill).

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
| 4 | `@koi/sandbox-cloudflare` + `@koi/sandbox-vercel` | Both cloud packages, shim templates, SQLite ledger, provider-smoke workflow, `docs/L2/sandbox-cloudflare.md` + `docs/L2/sandbox-vercel.md`, edge cassettes. | ~900 LOC |

PRs 3 and 4 can land in parallel after PR 2 merges. Each PR is gated independently by the acceptance criteria below for its scope only.

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
- [ ] PR < 1500 LOC each (if they don't fit together, split into PR 4a Cloudflare and PR 4b Vercel)
