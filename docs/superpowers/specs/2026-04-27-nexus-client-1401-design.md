# Nexus Client — Health Check (issue #1401)

**Status:** Design approved 2026-04-27
**Branch:** `feat/nexus-client-1401`
**Issue:** [#1401](https://github.com/windoliver/koi/issues/1401) — v2 Phase 3-nexus-1: nexus-client + nexus-transport
**Layer:** L2 (`@koi/nexus-client`, depends on `@koi/core` only)

## Context

Issue #1401 originally specified a broad nexus client/transport package: HTTP + gRPC + WebSocket transport abstraction, connection pool, retry, health check, typed wrappers.

Investigation against the two reference codebases showed most of this is either **already done** or **YAGNI**:

| Source | gRPC | WebSocket (RPC) | HTTP |
|---|---|---|---|
| `claude-code-source-code` | none | sessions/MCP only, never RPC | yes |
| `archive/v1/packages/**/nexus-*` | none | none (SSE for ipc-nexus push only) | yes |

Existing v2 `@koi/nexus-client` already provides:

- HTTP JSON-RPC 2.0 transport (`POST /api/nfs/<method>`)
- Retry with exponential backoff + jitter
- Retryable-method allowlist (read/list/grep/version/...)
- Deadline / abort / timeout via `AbortSignal.any`
- Per-consumer typed `call<T>` (each nexus surface owns its response types — `fs-nexus`, `permissions-nexus`, `audit-sink-nexus`)

## Scope of this change

**Build:** a `health()` method on `NexusTransport` that detects unhealthy Nexus before downstream callers issue real RPCs.

**Skip (with rationale documented in package README):**

| Punted | Why |
|---|---|
| gRPC transport | Zero precedent in v1 or claude-code; no caller in v2 |
| WebSocket RPC transport | Same — WebSocket is used for sessions, not for nexus RPC |
| Pluggable transport interface | Rule of Three — only one impl exists; abstraction is premature |
| Connection pool | HTTP/1.1 keep-alive in `fetch` already pools; adding a layer adds no value |
| Central typed wrapper helpers | Each consumer already owns its response types — correct boundary |

## Public API

```ts
// src/types.ts
export interface NexusHealth {
  readonly ok: boolean;
  readonly version: string;
  readonly latencyMs: number;
  /** Methods exercised by the readiness probe (for diagnostics / debugging). */
  readonly probed: readonly string[];
}

/** Base transport — minimal surface, satisfied by tests/mocks/fixtures. */
export interface NexusTransport {
  readonly call: <T>(
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Result<T, KoiError>>;
  /** OPTIONAL on the base type so test fixtures don't need stubs. */
  readonly health?: () => Promise<Result<NexusHealth, KoiError>>;
  readonly close: () => void;
}

/**
 * Stronger contract — production transports MUST satisfy this.
 * `createHttpTransport` returns `HealthCapableNexusTransport`; runtime
 * startup accepts ONLY this type, so missing health is a compile error.
 */
export interface HealthCapableNexusTransport extends NexusTransport {
  readonly health: () => Promise<Result<NexusHealth, KoiError>>;
}
```

### Why optional on the type, but required at the production boundary

Audit shows 12+ structural implementers of `NexusTransport` across the repo. Two categories:

| Category | Examples | health() requirement |
|---|---|---|
| **Production transports** | `createHttpTransport` (this package); fs-nexus `local-bridge` transport (cast in `meta/cli/tui-command.ts:1704`) | **MUST implement** |
| **Test fixtures / mocks** | `fs-nexus/test-helpers.ts`, `testing.ts`, per-package test stubs | MAY omit (no startup path) |

The interface keeps `health` optional so fixtures don't need no-op stubs, but startup code enforces it via a runtime guard (`assertHealthCapable`). This gives us:

1. Source compatibility for tests (no mass churn)
2. Fail-closed enforcement at the single boundary that matters (runtime startup)
3. Clear error message when a non-production transport is wired into production: "transport does not support health check"

## Implementation

`health()` is a **control-plane readiness probe** — narrower than full system readiness. It validates the transport can reach Nexus and that the permissions/auth path is functional. Data-plane failures (audit writes, fs writes, trajectory persistence) are NOT covered and will surface on first real use. This is documented as the explicit contract.

### What `health()` checks (in this PR)

1. Record `start = performance.now()`
2. Call `transport.call("version", {})` — liveness: TCP+TLS+JSON-RPC handler reachable; version string captured for diagnostics.
3. Call `transport.call("permissions.check", { scope: "__nexus_health__", path: "__nexus_health__" })` — readiness: bearer-token auth, tenant routing, permission backend init, handler dispatch all exercised. A `200 OK` with valid JSON-RPC envelope is the success signal (the sentinel scope is expected to return `allowed: false` and that is fine).
4. Both calls go through `transport.call(...)` — including from local-bridge (so the subprocess IPC, line parsing, and stdio channel are exercised end-to-end, not bypassed).
5. Both use `HEALTH_DEADLINE_MS = 5_000` overriding the default 45s.
6. On both success: return `{ ok: true, value: { ok: true, version, latencyMs, probed: ["version", "permissions.check"] } }`.
7. On any failure: propagate existing `KoiError` via `mapNexusError`.

### What `health()` deliberately does NOT check

| Capability | Probed? | Why not |
|---|---|---|
| `version` (liveness) | ✅ | trivial cost |
| `permissions.check` (auth+routing) | ✅ | most-invoked path; cheap; exercises full control plane |
| Audit `append` (write) | ❌ | side-effecting; would pollute audit log with sentinel records |
| FS `write` / `edit` (write) | ❌ | side-effecting on user filesystem |
| Trajectory delegate writes | ❌ | side-effecting; depends on session state not yet established at boot |
| FS `read` of a real path | ❌ | requires knowing a probe path that exists on every Nexus deployment |

The `probed` field on `NexusHealth` is exposed so callers know which subsystems were validated. If a future PR adds an audit/fs probe, that will be additive (new entries in `probed`).

### Documented contract (in `docs/L2/nexus-client.md` and on the type)

> `health()` confirms the Nexus control plane (auth, routing, permissions handler) is responsive. It does NOT prove that audit writes, fs writes, or trajectory persistence will succeed. Those data-plane failures surface on first real call. If you need stronger pre-session guarantees, run consumer-specific probes after `health()` succeeds.

### Local-bridge specifics

The fs-nexus `local-bridge` transport is a spawned Python subprocess speaking JSON-RPC over stdin/stdout. Its `health()` MUST execute the same `version` + `permissions.check` calls **through `transport.call(...)`** so the subprocess startup, IPC handshake, line parsing, and notification routing are all exercised. Direct in-process calls to bridge handlers are explicitly forbidden (would create false-positive readiness).

### Future server change (out of scope)

If the Nexus server adds a dedicated `health` or `ready` RPC that aggregates all subsystem checks (incl. audit/fs storage), `health()` switches to that single call. Until then, the documented control-plane-only contract is the honest one.

## Startup integration (fail-closed, compile-time enforced)

The real production boundary that owns the Nexus transport is `packages/meta/cli/src/runtime-factory.ts:832` (`KoiRuntimeFactoryConfig.nexusTransport`). `packages/meta/runtime/src/types.ts` does not currently expose this field — the runtime factory in `meta/cli` is what actually wires Nexus into the permission backend (`createNexusPermissionBackend`) and audit sink (`createNexusAuditSink`).

**Therefore: the type strengthening + preflight live in `meta/cli/runtime-factory.ts`, not `meta/runtime/create-runtime.ts`.**

```ts
// packages/meta/cli/src/runtime-factory.ts
import type { HealthCapableNexusTransport } from "@koi/nexus-client";

interface KoiRuntimeFactoryConfig {
  // …
  /** When set, runtime preflights Nexus health at startup; throws on failure. */
  readonly nexusTransport?: HealthCapableNexusTransport | undefined;
}

export async function createKoiRuntime(config: KoiRuntimeFactoryConfig) {
  // … existing setup …
  if (config.nexusTransport !== undefined) {
    const result = await config.nexusTransport.health();
    if (!result.ok) {
      throw new Error(
        `Nexus unavailable at startup: ${result.error.message} (code=${result.error.code})`,
        { cause: result.error },
      );
    }
  }
  // … then build permission backend + audit sink …
}
```

**Type-system enforcement:** the field is typed `HealthCapableNexusTransport`. Production transports (`createHttpTransport`, `createLocalBridgeTransport` in fs-nexus) must return this type to be passable. TypeScript rejects a base `NexusTransport`. The `as unknown as NexusTransport` cast in `tui-command.ts:1704` becomes `assertHealthCapable(transport)` (narrowing assertion).

**Policy:** block startup. Every nexus-using middleware (permissions, audit) will fail on its first call anyway; failing 5s into boot with a clear error beats failing minutes later mid-conversation. No warn-and-degrade — there is no useful degraded mode (denying every permission check is worse than not booting).

**Local-first permissions caveat:** `createNexusPermissionBackend` is documented as "local-first: TUI rules apply when Nexus has no policy or is unreachable." Health-check failure overrides this — startup blocks rather than silently dropping into local-only mode. Rationale: silent fallback at boot hides config errors; explicit failure surfaces them. After successful boot, transient unreachability still falls back to local rules per existing behavior.

`assertHealthCapable<T extends NexusTransport>(t: T): asserts t is T & HealthCapableNexusTransport` is the assertion helper for callers holding a base `NexusTransport` reference.

## Files

| File | Change | Est LOC |
|---|---|---|
| `packages/lib/nexus-client/src/types.ts` | Add `NexusHealth`, optional `health` on `NexusTransport`, required `health` on new `HealthCapableNexusTransport` | +18 |
| `packages/lib/nexus-client/src/transport.ts` | Implement `health()` (version + permissions.check); per-call deadline override; return type narrowed to `HealthCapableNexusTransport` | +45 |
| `packages/lib/nexus-client/src/health.test.ts` | New: both probes ok; version 5xx; permissions.check 5xx; auth failure (401); timeout; network error; malformed response | +130 |
| `packages/lib/nexus-client/src/assert-health-capable.ts` | New: `assertHealthCapable` assertion function | +15 |
| `packages/lib/nexus-client/src/assert-health-capable.test.ts` | New: present narrows; missing throws | +25 |
| `packages/lib/nexus-client/src/index.ts` | Re-export `NexusHealth`, `HealthCapableNexusTransport`, `assertHealthCapable` | +3 |
| `packages/lib/fs-nexus/src/local-transport.ts` | Implement `health()` on local-bridge — calls `transport.call("version")` + `transport.call("permissions.check")` through the real subprocess stdio channel (NOT direct handler calls); return type → `HealthCapableNexusTransport` | +35 |
| `packages/lib/fs-nexus/src/local-transport.test.ts` | New tests: health success through subprocess; failure when subprocess dead; failure when stdio handshake broken | +60 |
| `packages/meta/cli/src/runtime-factory.ts` | Type `nexusTransport` field as `HealthCapableNexusTransport`; wire preflight before `createNexusPermissionBackend`/`createNexusAuditSink`; throw on failure | +25 |
| `packages/meta/cli/src/__tests__/runtime-factory-health.test.ts` | New: startup blocks on failing health; succeeds on ok; skips when no transport; error includes nexus error code | +75 |
| `packages/meta/cli/src/tui-command.ts` | Replace `as unknown as NexusTransport` cast (line 1704) with `assertHealthCapable(transport)` narrowing | +5 |
| `docs/L2/nexus-client.md` | Document readiness probe semantics; `HealthCapableNexusTransport` contract; WS/gRPC/pool out-of-scope rationale | +60 |

**Total: ~436 LOC (131 src + 245 test + 60 doc).**

(Larger than the original ~170 estimate because reviews correctly demanded real integration, type-system enforcement, and a readiness probe — not just a dead liveness API.)

(Larger than the original ~170 estimate because the review correctly demanded real integration, not just a dead API.)

## Tests (TDD — written before code)

`packages/lib/nexus-client/src/health.test.ts`:

1. `health() returns ok with version, latency, probed=[version,permissions.check] when both probes succeed`
2. `health() returns error when version probe returns 503` — fail at liveness step
3. `health() returns error when permissions.check returns 503` — fail at readiness step (proves we don't stop at version)
4. `health() returns error when permissions.check returns 401 (auth failure)` — proves auth path is exercised
5. `health() returns error on timeout shorter than default deadline`
6. `health() returns error on network failure`
7. `health() returns error on malformed response`
8. `health() probes execute within HEALTH_DEADLINE_MS not default deadline`

`packages/lib/nexus-client/src/assert-health-capable.test.ts`:

9. `assertHealthCapable narrows type when health is present`
10. `assertHealthCapable throws KoiError-shaped error when health is undefined`

`packages/meta/cli/src/__tests__/runtime-factory-health.test.ts`:

11. `createKoiRuntime throws when transport.health() returns error` — fail-closed at startup
12. `createKoiRuntime succeeds when transport.health() returns ok`
13. `createKoiRuntime skips preflight when nexusTransport is undefined`
14. `createKoiRuntime startup error includes nexus error code in message`
15. `createKoiRuntime preflight runs before createNexusPermissionBackend wiring` (order matters)

`packages/lib/fs-nexus/src/local-transport.test.ts` (additions):

16. `local-bridge health() returns ok when subprocess + JSON-RPC channel are healthy`
17. `local-bridge health() returns error when subprocess has exited`
18. `local-bridge health() returns error when stdio handshake fails before probes complete`

Existing `transport.test.ts` continues to pass unchanged.

## Out of scope

- gRPC client
- WebSocket transport
- Pluggable `Transport` discriminated union
- Connection pool layer
- Central typed method wrappers (`batchRead`, paths, delegation API from v1) — port these per-consumer in their own packages if/when needed
- **Audit/fs/trajectory write probes** in `health()` — would be side-effecting; data-plane failures surface on first real call (documented contract)
- **Server-side dedicated `health` RPC** — Nexus server change; future work

## Acceptance

- [ ] All existing `nexus-client`, `fs-nexus`, `meta/runtime` tests still pass
- [ ] New `health.test.ts` passes (6 cases, ≥80% coverage on new code)
- [ ] New `assert-health-capable.test.ts` passes
- [ ] New `local-transport.test.ts` health case passes
- [ ] **New `create-runtime-health.test.ts` proves fail-closed startup:**
  - `runtime throws when transport.health is undefined` (capability missing)
  - `runtime throws when transport.health() returns error` (nexus unhealthy)
  - `runtime succeeds when transport.health() returns ok`
  - `runtime skips preflight when no nexus transport configured`
- [ ] `bun run typecheck`, `bun run lint`, `bun run check:layers` clean
- [ ] PR description explains punted scope (gRPC/WS/pool) with rationale
- [ ] Issue #1401 closed by PR
