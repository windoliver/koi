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
| `sandbox-cloudflare` | `SandboxAdapter` + `SandboxInstance` from `@koi/core/sandbox-adapter.ts`. |
| `sandbox-vercel` | Same as cloudflare. |

### Why wasm does not implement `SandboxExecutor`

The kernel `SandboxExecutor.execute(code: string, input: unknown, timeoutMs, ctx)` is a code-string contract — `code` is source text consumed by a runtime that can interpret it. Treating WASM bytes as `code: string` (e.g., base64) silently breaks generic consumers: a router that picks `SandboxExecutor` by capability cannot tell which executor will accept which payload, and routing a JS source string to a wasm-only backend produces a mis-execution that the contract cannot detect.

Therefore `sandbox-wasm` defines its own contract in `types.ts`:

```ts
export interface WasmExecutor {
  readonly execute: (
    module: Uint8Array | WebAssembly.Module,
    call: { readonly export: string; readonly args: readonly unknown[] },
    options?: { readonly timeoutMs?: number; readonly maxMemoryPages?: number; readonly imports?: WebAssembly.Imports },
  ) => Promise<Result<WasmResult, SandboxError>>;
}
```

This is intentionally NOT `SandboxExecutor`. Consumers wanting to plug wasm into a `SandboxExecutor`-shaped slot must build their own bridge that decides what `code: string` means for them (e.g., base64-of-bytes plus structured input). Building that bridge is out of scope for this PR — it would be a `sandbox-wasm-executor-bridge` follow-up package once a real consumer needs it.

Cloudflare/Vercel implement `SandboxAdapter` because they genuinely run process-level commands inside the deployed worker; that contract fits.

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
- **Memory enforcement is real, not advertised:** the executor accepts a module only if its memory section is **imported**, not internal. This is checked before instantiation by parsing the module's import section (using `WebAssembly.Module.imports(module)`) and rejecting any module whose memory is declared in its own memory section. The host then passes a `WebAssembly.Memory({ initial, maximum })` of its choosing as the imported memory. A module that defines its own memory (`(memory $m 1)`) cannot be retroactively clamped, so it is rejected with `KoiError { code: "PERMISSION", reason: "module-defines-internal-memory" }`. This rejection is enforced symmetrically in both the trusted-sync and untrusted-async executors.
- **Imports allowlist:** by default `imports` config is empty (`{}`); the executor injects only the host-controlled memory. Any module import not satisfied by the allowlist (other than the memory) causes `WebAssembly.Module.imports` validation to surface a `LinkError` → mapped to `PERMISSION`.
- CPU cap = worker termination (async) / advisory only (sync — trusted code only). No instruction metering — explicitly out of scope.
- Code input: caller passes WASM bytes (`Uint8Array`) or a pre-validated `WebAssembly.Module` plus the exported function name and args.
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
  instance.ts          — SandboxInstance over deployed worker URL
  adapter.ts           — createCloudflareAdapter → SandboxAdapter
  *.test.ts
  __tests__/integration.test.ts — env-gated live deploy
```

- Auth: `apiToken` + `accountId` from config. Token never logged.
- **Per-instance script naming:** every `create()` call deploys to a unique script name `${configPrefix}-${randomUUID()}` (e.g., `koi-sandbox-7f3a...`). Config supplies an optional `scriptPrefix` (default `koi-sandbox`); the random suffix is owned by the instance. Two concurrent `create()` calls cannot collide, and `destroy()` only deletes the instance's own script.
- Endpoint: `https://api.cloudflare.com/client/v4/accounts/{accountId}/workers/scripts/{instanceScriptName}` for deploy/delete; deployed worker URL for invoke.
- Network: only `fetch` — no SDK dep.
- Instance:
  - Owns its own `scriptName` (private field, set at create time, never reused).
  - `exec(cmd, args, opts)` posts a JSON-only subset of `opts` (cwd, env, stdin, timeoutMs, maxOutputBytes) to its own worker URL → translates JSON response to `SandboxAdapterResult`.
  - `readFile`/`writeFile` → **fail-closed** with `KoiError { code: "UNSUPPORTED" }`. Edge runtimes have no persistent host filesystem across requests, and request handling is not guaranteed to hit the same warm isolate, so honoring these methods would produce nondeterministic data loss. The contract is documented as **stateless single-request execution**: every `exec()` is independent; there is no instance-local state that survives between calls. Callers needing file state must use a different adapter (docker/e2b/local) or model storage explicitly via tool calls inside `exec()` payloads.
  - `destroy()` → DELETE only this instance's script. Idempotent (404 on re-destroy is success).

#### Stateless instance contract

The `SandboxInstance` contract suggests instance-local coherent state (`readFile` after `writeFile` returning the same bytes). Cloud edge adapters cannot honor that without a backing store, so they advertise stateless semantics explicitly:

- Capability declaration: `capabilities.supports = Set(["exec"])` only — NOT `"filesystem-rw"`. The router will not pick this adapter for profiles that require persistence.
- `readFile`/`writeFile` always throw `UNSUPPORTED` — they are present on the type only because the kernel `SandboxInstance` interface requires them. Implementations are honest stubs.
- Multiple `exec()` calls on the same instance are independent: no shared `cwd`, no shared in-memory state, no guarantee of hitting the same isolate. Documented in `docs/L2/sandbox-cloudflare.md` and `sandbox-vercel.md`.
- A future PR can add a `sandbox-cloudflare-kv` package that backs files with KV/Durable Objects; that is out of scope here and explicitly listed in "Out of scope" below.

#### `SandboxExecOptions` enforcement (fail-closed)

Every option is one of: **mapped** (forwarded over the wire), **rejected** (instance returns typed error before issuing fetch), or **bridged-locally** (wrapped at the host without provider participation):

| Option | Disposition | Notes |
|--------|-------------|-------|
| `cwd`, `env`, `stdin`, `timeoutMs`, `maxOutputBytes` | mapped | JSON-serializable; passed in POST body |
| `onStdout`, `onStderr` | **rejected** | Throw `KoiError { code: "UNSUPPORTED" }` immediately if either is set. No silent drop. |
| `signal` (`AbortSignal`) | **bridged-locally + remote-cancel** | (a) Local: abort the host `fetch` with the same signal so the caller's promise rejects on schedule. (b) Remote: when signal fires OR `timeoutMs` elapses, fire-and-forget POST to a `/cancel` endpoint on the worker. The shim implements `/cancel` by aborting in-flight work it controls. |

#### Cancellation honesty

Cloudflare Workers cannot guarantee preemption of arbitrary user code in the deployed shim. The contract therefore is:

- Local abort fires on schedule — caller's promise rejects with `TIMEOUT`.
- Remote cancel is **best-effort**. If the shim's `/cancel` does not return 200 within 2s after the abort, the instance is marked **poisoned**: subsequent `exec`/`readFile`/`writeFile` calls fail-closed with `KoiError { code: "POISONED" }` and the only valid operation is `destroy()`.
- `destroy()` on a poisoned instance proceeds normally (DELETE script). Caller must `create()` a new instance.

This is documented behavior — never silently retry on the same instance after timeout, because the prior command may still be running with side effects.
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
| `env` | mapped | Forwarded as Worker secrets via `PUT /workers/scripts/{name}/secrets` per key (typed) before deploy. |
| `nexusMounts` | REJECT | Requires FUSE; not available on edge. |
| `ssh` | REJECT | SSH-specific, not relevant to edge. |
| `required` (capabilities) | inspected by router, not by this adapter | Router rejects upstream; adapter ignores. |
| Unknown future fields | REJECT (default-deny) | TypeScript catches at compile time; runtime exhaustive check guards against type-erasure bugs. |

Vercel applies the same template with provider-appropriate numeric caps (memory: 1024MB Edge / 3008MB Serverless Pro; CPU: 30_000ms Edge / 900_000ms Serverless).

The mapping lives in `validate.ts` as a pure function `mapProfileToCloudflare(profile): Result<CloudflareDeployConfig, KoiError>`. Adapter `create()` calls it first and short-circuits on error before any fetch. The function uses an exhaustive switch over a discriminated union derived from the profile so adding a new core field without updating this mapper is a TypeScript error.

#### Profile conformance tests

`packages/sandbox/sandbox-conformance` provides a profile-rejection harness. Each cloud package adds a conformance test that walks every documented profile field and asserts the accept/reject behavior above. A separate gate test imports `SandboxProfile` reflectively and fails if any top-level key is missing from the cloud mapping table — this prevents new core fields from landing without an explicit edge-adapter decision.

### `@koi/sandbox-vercel` (~350 LOC src + tests)

Mirrors cloudflare's per-instance isolation pattern:

- Endpoint: `https://api.vercel.com/v13/deployments` (create), `/v13/deployments/{id}` (delete).
- Auth: `vercelToken` + `teamId?` from config.
- **Per-instance deployment:** each `create()` produces a fresh deployment with its own `id` returned by Vercel. Instance owns the `id` and only deletes that id in `destroy()`. Concurrent creates cannot collide because Vercel allocates ids server-side.
- `destroy()` is idempotent — 404 on re-destroy treated as success.
- Function shim ≤80 LOC, same protocol as CF shim (POST `/exec`, `/read`, `/write`).

## Sharing strategy

The two cloud adapters share ~150 LOC of pattern (HTTP fetch with timeout, error classify, instance protocol). **Do not extract a shared cloud-base package this PR** — Rule of Three: 2 occurrences = duplicate; revisit when a third edge adapter lands. Keep duplication explicit and obvious; small helper differences (auth header, endpoint shape) make a shared abstraction premature.

## Tests

### Unit (`bun:test`, in CI)

- `validate.test.ts`: every config field — missing token, malformed accountId, invalid script name, etc.
- `classify.test.ts`: every error path → KoiError shape.
- `wasm-executor.test.ts`: real `WebAssembly` modules built inline (e.g., `add(i32,i32)` from a small wat→wasm fixture committed under `__fixtures__/`). Tests: success, trap, OOM, timeout, invalid module bytes.
- `async-executor.test.ts`: same + abort signal, async host imports.
- `module-loader.test.ts`: bytes loader + URL loader (mocked fetch).
- `adapter.test.ts` (cloud): `createXAdapter` returns `Result.ok` on valid config, `Result.err UNAVAILABLE` on probe failure (mocked fetch).
- `instance.test.ts` (cloud): `exec` happy path, non-200 → KoiError, timeout via AbortSignal, `destroy` deletes script.

Coverage threshold: 80% per `bunfig.toml`.

### Integration (env-gated developer harness)

- `__tests__/integration.test.ts` per cloud package: skipped unless `CF_API_TOKEN` / `VERCEL_TOKEN` set. Deploys a real worker/function, invokes once, deletes. Used during local development.

### Provider smoke (mandatory pre-merge gate)

Mocked fetch is insufficient evidence for auth, header shape, endpoint correctness, response parsing, and cleanup. A separate **required** workflow `provider-smoke.yml` runs against shared sandbox accounts (CF + Vercel) on every PR that touches `packages/sandbox/sandbox-cloudflare/**` or `packages/sandbox/sandbox-vercel/**`:

1. **create** — deploy a tagged sandbox (`scriptPrefix: koi-ci-${runId}`)
2. **invoke** — execute a hello-world tool call, assert response
3. **destroy** — DELETE; assert 200/204 on first call, then 404 on second (idempotency)
4. **leak check** — list scripts/deployments by `koi-ci-` prefix older than 1h; fail the job if any are found

Tokens stored in repo secrets (`CF_CI_API_TOKEN`, `VERCEL_CI_TOKEN`), scoped to a sandbox account with billing alarm. The workflow blocks merge if any step (especially destroy + leak check) fails. Forks without secret access skip the gate; CODEOWNERS approval required for fork PRs that touch these paths.

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
- Streaming output (`onStdout`/`onStderr` callbacks return whole-buffer for cloud; future enhancement)
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
