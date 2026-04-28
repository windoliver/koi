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
  readonly health: () => Promise<Result<NexusHealth, KoiError>>;  // NEW
  readonly close: () => void;
}
```

## Implementation

`health()` calls the existing `version` JSON-RPC method (already in `RETRYABLE_METHODS`):

1. Record `start = performance.now()`
2. Issue `call<{ version: string }>("version", {})` with a short health-check deadline (`HEALTH_DEADLINE_MS = 5_000`) overriding the default 45s
3. On success: return `{ ok: true, value: { ok: true, version, latencyMs: now - start } }`
4. On failure: propagate the existing `KoiError` from `mapNexusError` — caller decides what to do

A short deadline matters because health-check is called from startup paths (e.g., runtime boot) where blocking 45s on a dead Nexus is unacceptable.

## Files

| File | Change | Est LOC |
|---|---|---|
| `src/types.ts` | Add `NexusHealth`; add `health` to `NexusTransport` | +10 |
| `src/transport.ts` | Implement `health()`; refactor `call()` to accept a per-call deadline override (private helper) | +30 |
| `src/health.test.ts` | New: ok, unhealthy 5xx, timeout, network error, malformed response | +90 |
| `src/index.ts` | Re-export `NexusHealth` | +1 |
| `docs/L2/nexus-client.md` | Document health check; document WS/gRPC/pool out-of-scope rationale | +40 |

**Total: ~170 LOC (40 src + 90 test + 40 doc).**

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

- [ ] All existing `nexus-client` tests still pass
- [ ] New `health.test.ts` passes (6 cases, ≥80% coverage on new code)
- [ ] `bun run typecheck`, `bun run lint`, `bun run check:layers` clean
- [ ] PR description explains punted scope with rationale
- [ ] Issue #1401 closed by PR
