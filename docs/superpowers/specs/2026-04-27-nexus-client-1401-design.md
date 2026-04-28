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
}

export interface NexusTransport {
  readonly call: <T>(
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Result<T, KoiError>>;
  /** OPTIONAL — implementers opt in; callers must check for `undefined`. */
  readonly health?: () => Promise<Result<NexusHealth, KoiError>>;  // NEW (optional)
  readonly close: () => void;
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

`health()` calls the existing `version` JSON-RPC method (already in `RETRYABLE_METHODS`):

1. Record `start = performance.now()`
2. Issue `call<{ version: string }>("version", {})` with a short health-check deadline (`HEALTH_DEADLINE_MS = 5_000`) overriding the default 45s
3. On success: return `{ ok: true, value: { ok: true, version, latencyMs: now - start } }`
4. On failure: propagate the existing `KoiError` from `mapNexusError` — caller decides what to do

A short deadline matters because health-check is called from startup paths (e.g., runtime boot) where blocking 45s on a dead Nexus is unacceptable.

## Startup integration (fail-closed)

The runtime is the single integration boundary. Pseudocode for `packages/meta/runtime/src/create-runtime.ts` after the transport is constructed and before it is handed to permissions/audit/fs middleware:

```ts
import { assertHealthCapable } from "@koi/nexus-client";

if (nexusTransport !== undefined) {
  const health = assertHealthCapable(nexusTransport);  // throws if undefined
  const result = await health();
  if (!result.ok) {
    throw new Error(
      `Nexus unavailable at startup: ${result.error.message} (code=${result.error.code})`,
      { cause: result.error },
    );
  }
}
```

**Policy:** block startup. Rationale — every nexus-using middleware (permissions, audit, fs-nexus) will fail on its first call anyway; failing 5s into boot with a clear message beats failing minutes later mid-conversation with a confusing one. No warn-and-degrade because there is no degraded mode (denying every permission check is worse than not booting).

`assertHealthCapable<T extends NexusTransport>(t: T): T & { health: NonNullable<T["health"]> }` is a tiny exported helper that throws if `health` is undefined. Pure type narrowing for callers.

## Files

| File | Change | Est LOC |
|---|---|---|
| `packages/lib/nexus-client/src/types.ts` | Add `NexusHealth`; add optional `health` to `NexusTransport` | +12 |
| `packages/lib/nexus-client/src/transport.ts` | Implement `health()`; per-call deadline override helper | +30 |
| `packages/lib/nexus-client/src/health.test.ts` | New: ok, unhealthy 5xx, timeout, network error, malformed response | +90 |
| `packages/lib/nexus-client/src/assert-health-capable.ts` | New: `assertHealthCapable` guard + test | +20 |
| `packages/lib/nexus-client/src/assert-health-capable.test.ts` | New: present, missing, narrowing | +30 |
| `packages/lib/nexus-client/src/index.ts` | Re-export `NexusHealth`, `assertHealthCapable` | +2 |
| `packages/lib/fs-nexus/src/local-transport.ts` | Implement `health()` on local-bridge transport (in-process equivalent — calls bridge `version`) | +25 |
| `packages/lib/fs-nexus/src/local-transport.test.ts` | New test for local-bridge `health()` | +30 |
| `packages/meta/runtime/src/create-runtime.ts` | Wire startup preflight: call `health()`, throw on failure | +20 |
| `packages/meta/runtime/src/__tests__/create-runtime-health.test.ts` | New: startup blocks on missing/failing health | +60 |
| `docs/L2/nexus-client.md` | Document health check; WS/gRPC/pool out-of-scope rationale; startup contract | +50 |

**Total: ~370 LOC (107 src + 210 test + 50 doc).**

(Larger than the original ~170 estimate because the review correctly demanded real integration, not just a dead API.)

## Tests (TDD — written before code)

`src/health.test.ts`:

1. `health() returns ok=true with version and latency on healthy Nexus` — mock fetch returns `{ result: { version: "1.2.3" } }`
2. `health() returns error with retryable=true on 503` — server unhealthy
3. `health() returns error on timeout shorter than default deadline` — verifies short deadline override
4. `health() returns error on network failure` — fetch throws
5. `health() returns error on malformed response` — JSON-RPC body missing `result` and `error`
6. `health() does not retry beyond health deadline` — verifies retries respect short deadline

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
