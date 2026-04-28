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

`health()` is a **readiness probe**, not a liveness probe. It must exercise the same code path production callers depend on (auth, routing, handler dispatch), not just prove the transport can reach JSON-RPC.

Sequence:

1. Record `start = performance.now()`
2. Call `version` first (cheap liveness — confirms TCP+TLS+JSON-RPC handler reachable). Capture version string for diagnostics.
3. Call `permissions.check` with a sentinel scope (`{ scope: "__nexus_health__", path: "__nexus_health__" }`). This exercises:
   - Bearer token auth
   - Tenant routing
   - Permission backend init
   - Handler registry dispatch
   The Nexus side is expected to return `{ allowed: false }` (sentinel never matches a real permission) — but a `200 OK` response with valid JSON-RPC envelope is the readiness signal. Auth/config/routing failures surface as 4xx/5xx and trip the failure path.
4. Both calls use a short deadline (`HEALTH_DEADLINE_MS = 5_000`) overriding the default 45s.
5. On both success: return `{ ok: true, value: { ok: true, version, latencyMs, probed: ["version", "permissions.check"] } }`.
6. On any failure: propagate the existing `KoiError` from `mapNexusError`.

**Why `permissions.check` as the readiness method:** it is the most commonly invoked Nexus method in production (every tool call), and it exercises the auth + routing + backend chain. If it fails at startup, every subsequent permission check would also fail — fail-fast is correct.

**Why not probe audit/fs separately:** in scope this PR. Per-consumer probes (audit ping, fs `stat /`) can be added later if `permissions.check` proves insufficient. Documented in the package README as a known limitation.

**Future server change (out of scope):** if the Nexus server adds a dedicated `health` or `ready` RPC that aggregates all subsystem checks, `health()` will switch to that single call. Until then, `version` + `permissions.check` is the closest available readiness signal.

## Startup integration (fail-closed, compile-time enforced)

The runtime is the single integration boundary. The startup config field is **typed** as `HealthCapableNexusTransport`, so missing health is caught at compile time, not runtime:

```ts
// packages/meta/runtime/src/create-runtime.ts
import type { HealthCapableNexusTransport } from "@koi/nexus-client";

interface RuntimeConfig {
  // …
  readonly nexusTransport?: HealthCapableNexusTransport | undefined;
}

if (config.nexusTransport !== undefined) {
  const result = await config.nexusTransport.health();
  if (!result.ok) {
    throw new Error(
      `Nexus unavailable at startup: ${result.error.message} (code=${result.error.code})`,
      { cause: result.error },
    );
  }
}
```

**Type-system enforcement:** every production caller (`createHttpTransport`, `local-bridge` transport in fs-nexus, future transports) must return `HealthCapableNexusTransport` to be passable to `createRuntime`. The base `NexusTransport` (without health) cannot be passed — TypeScript rejects it. No runtime guard needed at the boundary; the assertion helper still exists for callers building their own bridges.

**Policy:** block startup. Rationale — every nexus-using middleware (permissions, audit, fs-nexus) will fail on its first call anyway; failing 5s into boot with a clear error message beats failing minutes later mid-conversation with a confusing one. No warn-and-degrade because there is no degraded mode (denying every permission check is worse than not booting).

`assertHealthCapable<T extends NexusTransport>(t: T): asserts t is T & HealthCapableNexusTransport` is a small exported helper for places that hold a base `NexusTransport` reference (e.g., the `as unknown as` cast in `tui-command.ts:1704`) and need to narrow before passing to runtime.

## Files

| File | Change | Est LOC |
|---|---|---|
| `packages/lib/nexus-client/src/types.ts` | Add `NexusHealth`, optional `health` on `NexusTransport`, required `health` on new `HealthCapableNexusTransport` | +18 |
| `packages/lib/nexus-client/src/transport.ts` | Implement `health()` (version + permissions.check); per-call deadline override; return type narrowed to `HealthCapableNexusTransport` | +45 |
| `packages/lib/nexus-client/src/health.test.ts` | New: both probes ok; version 5xx; permissions.check 5xx; auth failure (401); timeout; network error; malformed response | +130 |
| `packages/lib/nexus-client/src/assert-health-capable.ts` | New: `assertHealthCapable` assertion function | +15 |
| `packages/lib/nexus-client/src/assert-health-capable.test.ts` | New: present narrows; missing throws | +25 |
| `packages/lib/nexus-client/src/index.ts` | Re-export `NexusHealth`, `HealthCapableNexusTransport`, `assertHealthCapable` | +3 |
| `packages/lib/fs-nexus/src/local-transport.ts` | Implement `health()` on local-bridge (in-process equivalent — direct calls to bridge handlers); return type → `HealthCapableNexusTransport` | +30 |
| `packages/lib/fs-nexus/src/local-transport.test.ts` | New test for local-bridge `health()` happy + failure | +35 |
| `packages/meta/runtime/src/create-runtime.ts` | Type field as `HealthCapableNexusTransport`; wire startup preflight | +15 |
| `packages/meta/runtime/src/__tests__/create-runtime-health.test.ts` | New: startup blocks on failing health; succeeds on ok; skips when no transport | +55 |
| `packages/meta/cli/src/tui-command.ts` | Replace `as unknown as NexusTransport` cast with `assertHealthCapable` narrowing | +5 |
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

`packages/meta/runtime/src/__tests__/create-runtime-health.test.ts`:

11. `createRuntime throws when transport.health() returns error` — fail-closed at startup
12. `createRuntime succeeds when transport.health() returns ok`
13. `createRuntime skips preflight when nexusTransport is undefined`
14. `createRuntime startup error includes nexus error code in message`

Existing `transport.test.ts` continues to pass unchanged.

## Out of scope

- gRPC client
- WebSocket transport
- Pluggable `Transport` discriminated union
- Connection pool layer
- Central typed method wrappers (`batchRead`, paths, delegation API from v1) — port these per-consumer in their own packages if/when needed

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
