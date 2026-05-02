# Multi-Backend Executor Abstraction (Issue #1641)

**Status:** Design approved 2026-05-01
**Issue:** [#1641](https://github.com/windoliver/koi/issues/1641) — v2 Phase 3: multi-backend executor abstraction
**Scope:** Phase 3 full — contract + router + sandbox-os adapter + SSH + audit + reversible (create-time) fallback + conformance suite. WASM backend deferred (W3).

## 1. Problem

Koi v2 has a `SandboxAdapter` L0 contract (used by `@koi/sandbox-docker`) that already covers `create/exec/copyIn(writeFile)/copyOut(readFile)/destroy/detach`, plus instance-level lifecycle (`active|detached|destroyed`). What's missing for multi-backend dispatch:

1. Adapters can't declare what they support (network/filesystem/spawn/persistence) — caller must hard-code which adapter to instantiate.
2. No router that picks an adapter from a registry based on a profile's requirements.
3. No backend-level lifecycle (`created|ready|degraded|terminated`) above instance lifecycle.
4. No selection audit trail (which adapter ran, why, what was rejected, what fell back).
5. Local subprocess execution (`@koi/sandbox-os`) exposes profile-translation primitives but is not itself a `SandboxAdapter`.
6. No SSH backend.
7. No shared conformance suite — adapters each test their own behavior in isolation.

## 2. Goal

Add a capability-declaring `SandboxAdapter` extension, a router that selects adapters with audit metadata and create-time fallback, two new adapters (`@koi/sandbox-local`, `@koi/sandbox-ssh`), capability hookup on existing `@koi/sandbox-docker`, a shared conformance suite, and threat-model docs per backend. WASM is **out of scope** for this issue (deferred — see §10).

## 3. Non-Goals

- **Live mid-session migration.** Reversible migration in this design = router fallback at `create()` only. Snapshot-based or state-handoff migration is future work.
- **Active health probing.** Adapter state transitions are passive (driven by `init/shutdown` hooks + recent failure history). No polling.
- **Cost-based selection.** Selection is static-capabilities + ordered priority. Cost weighting is future work.
- **WASM backend.** v1's `@koi/sandbox-wasm` was a QuickJS-in-WASM JS runner targeting the (unrelated) `SandboxExecutor` code-string contract. A WASI-compatible adapter for the session model has unclear utility without a tool ecosystem; deferred.
- **New cloud backends.** v1 had Cloudflare/E2B/Daytona/Vercel adapters; porting them is not part of this issue. The contract added here is forward-compatible with such ports.

## 4. Decisions

| # | Decision | Reasoning |
|---|----------|-----------|
| D1 | Static capabilities + ordered priority for selection | Rule of Three. v1 shipped without cost-based selection. Trivially upgradable later. |
| D2 | Router fallback at `create()` is the entire migration story | Snapshot/CRIU is fragile and most backends can't checkpoint. Create-time fallback covers real failure modes (Docker daemon down → local). |
| D3 | Backend lifecycle = `init/shutdown` hooks + passive failure tracking | No polling. `degraded` after N consecutive failures, `ready` on next success. |
| D4 | Extend existing `SandboxAdapter` additively (all new fields optional) | Avoids forking the contract. Existing callers (forge, bridge) stay untouched. |
| D5 | Skip WASM in this issue; ship local + Docker + SSH | Issue acceptance allows fast-follows. Forces honest scope. |
| D6 | SSH uses `ssh2` npm package, not pure Bun | Multi-week effort to write SSH from scratch; `ssh2` is mature and audited. |

## 5. L0 Contract Extensions (`@koi/core`)

All additions are **optional** — existing adapters continue to compile and run unchanged.

### 5.1 New types

```typescript
// New file: packages/kernel/core/src/adapter-capabilities.ts
export type AdapterCapability =
  | "exec"
  | "copy-files"
  | "spawn"
  | "persistence"
  | "network"
  | "filesystem-rw"
  | "gpu";

export interface AdapterCapabilities {
  readonly supports: ReadonlySet<AdapterCapability>;
  readonly priority: number; // lower = preferred (0=local, 10=docker, 20=ssh)
}

export type BackendState = "created" | "ready" | "degraded" | "terminated";

export interface BackendDescriptor {
  readonly name: string;
  readonly version: string;            // semver of adapter package
  readonly state: BackendState;
  readonly capabilities: AdapterCapabilities;
}

export interface CapabilityRequirements {
  readonly required: ReadonlySet<AdapterCapability>;
  readonly forbidden?: ReadonlySet<AdapterCapability>;
}
```

### 5.2 Extended `SandboxAdapter`

```typescript
// packages/kernel/core/src/sandbox-adapter.ts (additions only)
export interface SandboxAdapter {
  readonly name: string;
  readonly create: (profile: SandboxProfile) => Promise<SandboxInstance>;
  readonly findOrCreate?: ...;       // existing
  // NEW (all optional)
  readonly version?: string;
  readonly capabilities?: AdapterCapabilities;
  readonly init?: () => Promise<void>;
  readonly shutdown?: () => Promise<void>;
}
```

### 5.3 Extended `SandboxProfile`

```typescript
export interface SandboxProfile {
  // ... existing fields
  readonly required?: CapabilityRequirements;
  readonly ssh?: { readonly host: string; readonly user: string; readonly keyPath: string };
}
```

`profile.ssh` is consumed only by `@koi/sandbox-ssh`; other adapters ignore it. Per Anti-Leak rule it's still a generic L0 type (no SSH library types leak in).

### 5.4 New error codes

```typescript
// packages/kernel/core/src/error-codes.ts (additions)
"BACKEND_UNAVAILABLE"   // init() failed or all adapters terminated
"NO_ADAPTER_MATCHES"    // capability requirements unsatisfiable
"ALL_ADAPTERS_FAILED"   // every fallback create() failed
```

`ALL_ADAPTERS_FAILED` uses ES2022 `cause` chaining; `context.causedBy` carries the per-adapter error array.

## 6. Router Package: `@koi/sandbox-router`

L2 package, depends on `@koi/core` only.

### 6.1 Public API

```typescript
export interface RouterConfig {
  readonly adapters: readonly SandboxAdapter[];
  readonly degradedThreshold?: number; // default 3 consecutive failures
}

export interface SelectionAttempt {
  readonly adapter: string;
  readonly state: BackendState;
  readonly ok: boolean;
  readonly error?: KoiError;
}

export interface SelectionRejection {
  readonly adapter: string;
  readonly reason: "missing-capabilities" | "forbidden-capabilities" | "terminated";
  readonly missing?: readonly AdapterCapability[];
}

export interface SelectionDecision {
  readonly selected: BackendDescriptor;
  readonly attempts: readonly SelectionAttempt[];
  readonly rejected: readonly SelectionRejection[];
}

export interface SandboxRouter {
  readonly create: (profile: SandboxProfile) => Promise<Result<{
    readonly instance: SandboxInstance;
    readonly decision: SelectionDecision;
  }, KoiError>>;
  readonly describe: () => readonly BackendDescriptor[];
  readonly shutdown: () => Promise<void>;
}

export function createSandboxRouter(config: RouterConfig): SandboxRouter;
```

### 6.2 Selection algorithm

1. **Filter:** drop adapters where `capabilities.supports ⊉ profile.required.required`, or where `capabilities.supports ∩ profile.required.forbidden ≠ ∅`, or where `state === "terminated"`.
2. **Sort:** by `(state === "ready" ? 0 : 1, priority)`. Ready preferred over degraded; ties broken by lower priority number.
3. **Try:** call `create()` on each in order. On first success, return `{instance, decision}`.
4. **Failure tracking:** per-adapter consecutive failure count. At threshold, flip to `degraded`. Any success resets to `ready`.
5. **All fail:** return `Result<_, KoiError>` with code `ALL_ADAPTERS_FAILED` and `cause` chain of per-adapter errors.

### 6.3 Lifecycle

- Constructor: for each adapter, await `adapter.init?()`. State `created → ready` on success; `created → terminated` on failure (logged, adapter excluded from selection forever).
- `router.shutdown()`: for each non-terminated adapter, await `adapter.shutdown?()`, set state `terminated`. Idempotent.

### 6.4 Files

- `src/router.ts` (~150 LOC) — selection + state machine
- `src/match.ts` (~50 LOC) — capability matcher
- `src/decision.ts` (~30 LOC) — decision metadata builder
- `src/index.ts` — exports
- Tests colocated (`router.test.ts`, `match.test.ts`, `decision.test.ts`)

## 7. Backend Packages

### 7.1 `@koi/sandbox-local` (new)

Wraps `@koi/sandbox-os` profile-translation primitives into a `SandboxAdapter`.

| Method | Implementation |
|--------|----------------|
| `create(profile)` | Returns instance bound to profile; no upfront process spawn (per-exec isolation) |
| `instance.exec(cmd, args)` | `Bun.spawn` with `buildBwrapPrefix`/`buildSeatbeltPrefix` argv prefix; capture stdout/stderr/exit |
| `instance.spawn(cmd, args)` | `Bun.spawn` with stdin pipe + bidirectional streams |
| `instance.readFile`/`writeFile` | Direct host FS, gated by profile's `allowRead`/`allowWrite` paths |
| `instance.destroy` | No-op (no persistent state) |
| `findOrCreate` | Omitted (no `persistence` capability) |

- **Capabilities:** `{exec, copy-files, spawn, network, filesystem-rw}`, priority 0
- **Files:** `adapter.ts`, `instance.ts`, `index.ts` + tests; ~300 LOC
- **Threat model doc:** `docs/L2/sandbox-local.md` — seatbelt/bwrap escape, parent-process visibility, env leakage

### 7.2 `@koi/sandbox-docker` (extend)

One-line capability addition + optional `init/shutdown` hooks.

- **Capabilities:** `{exec, copy-files, spawn, persistence, network, filesystem-rw}`, priority 10
- **`init`:** probes Docker daemon (already done lazily; lift into `init`)
- **`shutdown`:** noop (clients GC themselves; close any pooled clients if added later)
- **Threat model doc:** `docs/L2/sandbox-docker.md` — daemon socket privilege, image trust, network egress

### 7.3 `@koi/sandbox-ssh` (new)

Depends on `ssh2` (pinned exact version). Connection per session, optional pool keyed by `findOrCreate` scope.

| Method | Implementation |
|--------|----------------|
| `create(profile)` | Open SSH connection from `profile.ssh`; auth via private key |
| `instance.exec(cmd, args)` | `client.exec(quotedCommand)` — args quoted via shell-quote-equivalent (no string concatenation) |
| `instance.readFile`/`writeFile` | SFTP subsystem |
| `instance.spawn` | `client.shell()` — bidirectional PTY |
| `instance.destroy` | Close connection |
| `findOrCreate(scope)` | Connection pool keyed by scope; return live connection if alive, else create new |

- **Capabilities:** `{exec, copy-files, spawn, persistence, network}`, priority 20. Note: `filesystem-rw` is per-session (depends on remote permissions) — declared at adapter level conservatively; per-instance verification in conformance suite.
- **Files:** `adapter.ts`, `instance.ts`, `connection-pool.ts`, `quote.ts`, `index.ts` + tests; ~400 LOC
- **Threat model doc:** `docs/L2/sandbox-ssh.md` — key handling, host-key verification (strict by default), command-injection at quoting boundary, MITM resistance

## 8. Conformance Suite: `@koi/sandbox-conformance`

Test-only L2 package, `private: true`, not published.

### 8.1 Mechanism

```typescript
export function describeSandboxConformance(
  adapter: SandboxAdapter,
  options?: { readonly skipNetworkTests?: boolean },
): void;
```

Each adapter package has `__tests__/conformance.test.ts` that imports and calls this. Capability-gated tests skip themselves if the adapter doesn't declare the capability.

### 8.2 Test groups

| Group | Verifies |
|-------|----------|
| Lifecycle | `init` → `ready`, `shutdown` → `terminated`, double-init/shutdown idempotent |
| Create+Destroy | `create()` returns instance; `destroy()` releases resources; double-destroy idempotent |
| Exec basics | exit 0 on success, non-zero on failure, stdout/stderr captured, env propagation, cwd respected |
| Exec timeout | `signal` kills process, returns `timedOut: true` |
| Exec output limits | `maxOutputBytes` truncates, sets `truncated: true` |
| copy-files | writeFile→readFile roundtrip; large file (>1 MB); missing path → typed error |
| spawn (capability-gated) | bidirectional stdin/stdout, kill via handle, `exited` resolves with code |
| Persistence (capability-gated) | `findOrCreate(scope)` returns same instance for same scope; survives detach/reattach |
| Profile enforcement | `network=false` blocks egress; `denyWrite` enforced; resource limits applied |
| Capability honesty | adapter behavior matches declared capabilities (e.g., if `persistence` declared, `findOrCreate` exists) |

### 8.3 Router conformance (separate, in `@koi/sandbox-router/__tests__/`)

- Ordered selection picks priority 0 first
- Required capability filter excludes adapters missing capability
- Forbidden capability filter excludes adapters that have it
- Failure on primary triggers fallback; decision metadata records both attempts
- N consecutive failures flip adapter to `degraded`; success flips back to `ready`
- All-adapters-fail returns aggregated typed error
- Decision metadata includes `selected.{name,version,state}`, `attempts[]`, `rejected[]`

## 9. Audit, Wiring, Docs

### 9.1 Audit trail

`SelectionDecision` is the audit unit, returned from `router.create()`. Caller decides persistence (router itself does not log to disk).

`@koi/runtime` will pass it through the existing event-trace middleware path so it appears in ATIF trajectories. Schema fields:

- `selected.{name, version, state, capabilities}`
- `attempts[].{adapter, state, ok, error}`
- `rejected[].{adapter, reason, missing}`

### 9.2 Runtime wiring (`@koi/runtime`)

- New dependency: `@koi/sandbox-router`
- Optional dependencies: `@koi/sandbox-local`, `@koi/sandbox-docker`, `@koi/sandbox-ssh`
- `createKoi()` accepts `sandbox?: SandboxRouter | SandboxAdapter`. When given an adapter directly, wraps it in a single-adapter router for back-compat.
- Default factory: build router from `[local]` always; add `docker` if Docker daemon reachable at startup; SSH only if explicitly configured (no SSH host probing by default — privacy + correctness).

### 9.3 Golden query coverage

Per CLAUDE.md golden-query rule (every new L2 package wires into `@koi/runtime`):

- New runtime golden query: `sandbox-router-fallback` — primary adapter (mock-failing local) fails, router falls back to mock docker, decision metadata captured in trajectory. No real LLM, no real network — pure router unit + mock adapters.
- Per-adapter standalone queries (2 per package):
  - **sandbox-local:** happy-path exec; capability-rejected when profile requires `gpu`
  - **sandbox-docker:** happy-path exec; rejected when daemon unreachable
  - **sandbox-ssh:** happy-path with mock ssh2 server; rejected when key file missing
  - **sandbox-router:** ordered selection; full fallback chain

### 9.4 Documentation

- `docs/L2/sandbox-router.md` — router contract, selection algorithm, audit shape
- `docs/L2/sandbox-local.md` — usage + threat model
- `docs/L2/sandbox-docker.md` — extend existing doc with capability declaration
- `docs/L2/sandbox-ssh.md` — usage + threat model
- `docs/L2/sandbox-threat-template.md` — shared template (trust boundary, privileged surfaces, escape vectors, mitigations, residual risk)

## 10. Out of Scope / Future Work

| Item | Defer to |
|------|----------|
| WASM backend (WASI-compatible) | Future issue once tool ecosystem justifies it |
| Cloud backends (Cloudflare, E2B, Daytona, Vercel) | Per-backend follow-up issues |
| Live mid-session migration (snapshot/CRIU) | Issue covering snapshot semantics |
| Cost-based selection | Future issue when real cost data exists |
| Active health probing | Only if a use case emerges |

## 11. PR Plan

Each PR is independently mergeable, < 1500 LOC of logic.

| # | PR | Depends on |
|---|----|-----|
| 1 | L0 contract additions + `@koi/sandbox-router` + `@koi/sandbox-conformance` | — |
| 2 | `@koi/sandbox-local` (wraps sandbox-os) + threat doc + conformance hookup | PR 1 |
| 3 | `@koi/sandbox-docker` capability declaration + threat doc + conformance hookup | PR 1 |
| 4 | `@koi/sandbox-ssh` (`ssh2` dep) + threat doc + conformance hookup | PR 1 |
| 5 | `@koi/runtime` wiring + golden queries + ATIF audit fields | PRs 2-4 |

## 12. Acceptance Criteria (mapped to issue)

| Issue criterion | Met by |
|-----------------|--------|
| Backend interface defined as L0 contract | §5 (additive extensions to existing `SandboxAdapter`) |
| At least 3 backends shipped: local, Docker, WASM | local + Docker + SSH (WASM deferred per D5; **issue acceptance to be revised — see §10**) |
| SSH backend as a fast-follow | SSH shipped in this issue, not fast-follow |
| Capability-based selection working | §6 (router) |
| Threat model docs per backend | §9.4 |
| Tests cover all backends with the same conformance suite | §8 |
| Documented in `docs/L2/executor.md` | §9.4 (split per package + router) |
| Conformance suite includes lifecycle transition tests per backend | §8.2 (Lifecycle group) |
| Selection decisions are traceable in decision metadata | §6.1, §9.1 |
| Failed backend migration can rollback to prior backend without session corruption | §6.2 step 5 (create-time fallback; D2 narrows "migration" to mean create-time) |
| Golden replay includes at least one backend selection + fallback scenario | §9.3 (`sandbox-router-fallback`) |

## 13. Risks

| Risk | Mitigation |
|------|------------|
| `ssh2` security CVEs | Pin exact version, audit on add, monitor security advisories, isolate behind adapter |
| WASM omission misaligned with issue | Surface in PR description; propose updating issue acceptance criteria |
| Capability declarations diverge from actual behavior | Conformance suite §8.2 "Capability honesty" group |
| Router fallback masks real config errors | Decision metadata always returned; runtime logs full attempt chain |
| Adapter `init` blocks startup if slow (e.g., Docker probe) | `init` runs concurrently across adapters; failures don't block other adapters |
