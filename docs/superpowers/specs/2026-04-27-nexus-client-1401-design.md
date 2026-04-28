# Nexus Client — Health Check (issue #1401)

**Status:** **DESIGN-ONLY (this PR).** Implementation lands in a follow-up PR. This document specifies what the implementation must do; merging this branch alone does NOT close #1401 and does NOT change runtime behavior.
**Branch:** `feat/nexus-client-1401` — currently docs-only
**Issue:** [#1401](https://github.com/windoliver/koi/issues/1401) — v2 Phase 3-nexus-1: nexus-client + nexus-transport
**Layer:** L2 (`@koi/nexus-client`, depends on `@koi/core` only)
**Implementation PR:** to be opened separately; will contain all source/test changes listed in the Files section below and will be the PR that closes #1401.

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

/** Optional per-call options. Currently only `deadlineMs` for health probes. */
export interface NexusCallOptions {
  /** Override transport's default deadline for this single call. */
  readonly deadlineMs?: number;
}

/** Tri-state health result: transport reachability AND policy-store bootstrap. */
export interface NexusHealth {
  /** Transport reachable + auth + JSON-RPC handler responding. */
  readonly transport: { readonly ok: true; readonly version: string; readonly latencyMs: number };
  /**
   * Permission policy store status:
   * - "synced": version.json exists and is readable (centralized policy active)
   * - "empty": Nexus reachable but version.json is 404 (local-only fallback,
   *   may indicate mis-mounted store, wrong tenant, or first-boot)
   */
  readonly policyStore: "synced" | "empty";
  readonly probed: readonly string[];
}

/** Base transport — minimal surface, satisfied by tests/mocks/fixtures. */
export interface NexusTransport {
  readonly call: <T>(
    method: string,
    params: Record<string, unknown>,
    opts?: NexusCallOptions,  // NEW: per-call deadline override
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

**Per-call deadline contract:** when `opts.deadlineMs` is set, the transport MUST honor that deadline regardless of its configured default. HTTP transport already wraps each call in `AbortSignal.any([abortController.signal, timeoutSignal])` — only needs to use the override when present. Local-bridge transport currently has a fixed `callTimeoutMs` (30s default); the implementation PR will add per-call deadline plumbing to its pending-request map (each request tracks its own deadline; reaper rejects on expiry).

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

The probe targets the **exact methods consumers actually call**. Audit of v2 callers:

| Consumer (file) | Methods called |
|---|---|
| `permissions-nexus/nexus-permission-backend.ts:59,80,116,129` | `read` of `koi/permissions/version.json` and `koi/permissions/policy.json` |
| `permissions-nexus/nexus-revocation-registry.ts:25,67` | `read`, `write` of revocations |
| `audit-sink-nexus/nexus-sink.ts` | `write` (audit append) |
| `permissions.check` (v1 RPC) | **NOT USED in v2** — v1 artifact still in `RETRYABLE_METHODS`; not the right probe |

Sequence:

1. Record `start = performance.now()`
2. `transport.call("version", {}, { deadlineMs: HEALTH_DEADLINE_MS })` — liveness: TCP+TLS+JSON-RPC reachable; capture version string. Failure → return `{ ok: false, error }`.
3. `transport.call("read", { path: "koi/permissions/version.json" }, { deadlineMs: HEALTH_DEADLINE_MS })` — exercises the exact code path `createNexusPermissionBackend` uses.
   - **200 OK** → `policyStore: "synced"` (centralized policy active)
   - **404** → `policyStore: "empty"` (transport ok but no policy synced — caller decides if this is acceptable)
   - **5xx / auth / network failure** → return `{ ok: false, error }` (real failure)
4. All calls go through `transport.call(...)` — local-bridge included.
5. Per-call `deadlineMs: HEALTH_DEADLINE_MS = 5_000` overrides each transport's default. Achievable on local-bridge once per-call deadline support is implemented (see Public API).
6. On success: `{ ok: true, value: { transport: { ok: true, version, latencyMs }, policyStore: "synced" | "empty", probed: ["version", "read:koi/permissions/version.json"] } }`.
7. On failure: propagate `KoiError` via `mapNexusError`.

### What `health()` deliberately does NOT check

| Capability | Probed? | Why not |
|---|---|---|
| `version` (liveness) | ✅ | trivial cost |
| `read koi/permissions/version.json` (real consumer path) | ✅ | exact path used by `createNexusPermissionBackend`; idempotent |
| Audit `write` (append) | ❌ | side-effecting; would pollute audit log with sentinel records |
| FS `write` / `edit` | ❌ | side-effecting on user filesystem |
| Trajectory delegate writes | ❌ | side-effecting; depends on session state not yet established at boot |

Audit-write readiness specifically is a known gap. Documented in the package README. If audit storage is broken, the first audit append fails and surfaces via existing audit-sink error handling. Adding a non-side-effecting audit readiness probe (e.g., a server-side `audit.ping` RPC) is future work and requires a Nexus server change.

The `probed` field on `NexusHealth` is exposed so callers know which subsystems were validated.

### Documented contract (in `docs/L2/nexus-client.md` and on the type)

> `health()` confirms the Nexus control plane (auth, routing, permissions handler) is responsive. It does NOT prove that audit writes, fs writes, or trajectory persistence will succeed. Those data-plane failures surface on first real call. If you need stronger pre-session guarantees, run consumer-specific probes after `health()` succeeds.

### Local-bridge specifics

The fs-nexus `local-bridge` transport is a spawned Python subprocess speaking JSON-RPC over stdin/stdout. Its `health()` MUST execute the same `version` + `read("koi/permissions/version.json")` calls **through `transport.call(...)`** so the subprocess startup, IPC handshake, line parsing, and notification routing are all exercised. Direct in-process calls to bridge handlers are explicitly forbidden (would create false-positive readiness).

### Future server change (out of scope)

If the Nexus server adds a dedicated `health` or `ready` RPC that aggregates all subsystem checks (incl. audit/fs storage), `health()` switches to that single call. Until then, the documented control-plane-only contract is the honest one.

## Startup integration (telemetry by default, opt-in fail-closed)

The real production boundary is `packages/meta/cli/src/runtime-factory.ts:832` (`KoiRuntimeFactoryConfig.nexusTransport`). The runtime factory wires Nexus into `createNexusPermissionBackend` and `createNexusAuditSink`.

**Critical existing contract: local-first permissions.** `createNexusPermissionBackend` is documented as "local-first: TUI rules apply when Nexus has no policy or is unreachable." A golden test in `meta/runtime/src/__tests__/golden-replay.test.ts` proves this fallback. **A fail-closed startup gate would break this contract** and convert recoverable Nexus outages into total runtime unavailability. That is a regression.

**Decision: default depends on configured consumers; fail-closed when audit sink is wired.**

Reasoning:

- Permissions backend tolerates Nexus unreachability via local-first fallback (existing contract). For permissions-only setups, telemetry-mode preserves availability.
- Audit sink (`createNexusAuditSink`) writes compliance records. Sink-write failures are **swallowed** by the audit queue unless an `onError` hook is set — so a broken Nexus audit path silently drops compliance data. For audit setups, telemetry mode is unsafe; fail-closed is the only correct default.
- `policyStore: "empty"` (404) is treated as a warning, not a hard failure, because it can be valid first-boot state. Operators who require centralized policy at boot use `nexusBootMode: "fail-closed-policy-required"` (rare; opt-in).

| Configured consumers | Default `nexusBootMode` |
|---|---|
| nexus permissions only | `telemetry` (preserves local-first) |
| nexus audit sink wired | `fail-closed` (compliance) |
| both | `fail-closed` (compliance wins) |
| operator override | always wins |

The runtime factory inspects whether `createNexusAuditSink` is being wired and selects the default accordingly.

```ts
// packages/meta/cli/src/runtime-factory.ts
import type { HealthCapableNexusTransport } from "@koi/nexus-client";

type NexusBootMode = "telemetry" | "fail-closed" | "fail-closed-policy-required";

interface KoiRuntimeFactoryConfig {
  // …
  readonly nexusTransport?: HealthCapableNexusTransport | undefined;
  /**
   * Behavior when startup health probe fails or policy store is empty.
   * Default: derived from configured consumers (see decision table).
   * - "telemetry": log warning, continue boot; preserves local-first.
   * - "fail-closed": throw on transport failure; warn on `policyStore: "empty"`.
   *   Default when nexus audit sink is wired (compliance).
   * - "fail-closed-policy-required": throw on transport failure OR empty policy.
   *   For multi-node deployments that require centralized policy at boot.
   */
  readonly nexusBootMode?: NexusBootMode | undefined;
}

export async function createKoiRuntime(config: KoiRuntimeFactoryConfig) {
  // … existing setup …
  if (config.nexusTransport !== undefined) {
    const auditWired = isNexusAuditConfigured(config);
    const mode: NexusBootMode = config.nexusBootMode ?? (auditWired ? "fail-closed" : "telemetry");

    const result = await config.nexusTransport.health();
    if (!result.ok) {
      const msg = `Nexus unhealthy at startup: ${result.error.message} (code=${result.error.code})`;
      if (mode === "telemetry") {
        logger.warn({ err: result.error }, msg);
      } else {
        throw new Error(msg, { cause: result.error });
      }
    } else {
      const { transport, policyStore, probed } = result.value;
      logger.info({ latencyMs: transport.latencyMs, version: transport.version, policyStore, probed },
        "nexus health ok");
      if (policyStore === "empty") {
        const policyMsg = "Nexus policy store empty (koi/permissions/version.json missing); local-first rules in effect";
        if (mode === "fail-closed-policy-required") {
          throw new Error(policyMsg);
        }
        logger.warn({ probed }, policyMsg);
      }
    }
  }
  // … then build permission backend + audit sink as before …
}
```

**Type-system enforcement:** field typed as `HealthCapableNexusTransport`. Production transports (`createHttpTransport`, fs-nexus `local-bridge`) must return this. TypeScript rejects a base `NexusTransport`. The `as unknown as NexusTransport` cast in `tui-command.ts:1704` becomes `assertHealthCapable(transport)`.

**Why this is the right policy:**

- Default mode preserves the existing local-first contract — no regression
- Operators get visibility into Nexus health via logs at every startup
- Compliance/security deployments opt in to `fail-closed` explicitly
- The golden test for local-first fallback continues to pass unchanged

`assertHealthCapable<T extends NexusTransport>(t: T): asserts t is T & HealthCapableNexusTransport` is the assertion helper.

## Files

| File | Change | Est LOC |
|---|---|---|
| `packages/lib/nexus-client/src/types.ts` | Add `NexusCallOptions`, tri-state `NexusHealth`, optional `health` on `NexusTransport`, required `health` on `HealthCapableNexusTransport`; extend `call` signature with optional `opts` | +25 |
| `packages/lib/nexus-client/src/transport.ts` | HTTP impl: thread `opts.deadlineMs` into existing `AbortSignal.timeout`; implement `health()` with both probes; return `HealthCapableNexusTransport` | +50 |
| `packages/lib/nexus-client/src/health.test.ts` | New: both probes ok → policyStore=synced; read 404 → policyStore=empty (still ok); version 5xx → fail; read 5xx → fail; read 401 → fail; timeout (per-call deadline honored); network error; malformed response | +160 |
| `packages/lib/nexus-client/src/assert-health-capable.ts` | New: `assertHealthCapable` assertion function | +15 |
| `packages/lib/nexus-client/src/assert-health-capable.test.ts` | New: present narrows; missing throws | +25 |
| `packages/lib/nexus-client/src/index.ts` | Re-export `NexusHealth`, `HealthCapableNexusTransport`, `assertHealthCapable` | +3 |
| `packages/lib/fs-nexus/src/local-transport.ts` | (1) Add per-call `opts.deadlineMs` support: each entry in pending-request map tracks its own deadline; reaper rejects on expiry. (2) Implement `health()` calling both probes through the real subprocess stdio channel with `deadlineMs: 5000` opts; return `HealthCapableNexusTransport` | +60 |
| `packages/lib/fs-nexus/src/local-transport.test.ts` | New: per-call deadline rejects before transport default; health success through subprocess; health failure when subprocess dead; health failure when stdio handshake broken; tri-state result wiring | +90 |
| `packages/meta/cli/src/runtime-factory.ts` | Type `nexusTransport` as `HealthCapableNexusTransport`; add `nexusBootMode` config field with derived default (audit-wired → fail-closed); add `isNexusAuditConfigured` helper; wire preflight before `createNexusPermissionBackend`/`createNexusAuditSink`; handle tri-state policyStore result | +50 |
| `packages/meta/cli/src/__tests__/runtime-factory-health.test.ts` | New tests covering all three modes + audit-aware default + policyStore=empty handling (see Tests section) | +160 |
| `packages/meta/cli/src/tui-command.ts` | Replace `as unknown as NexusTransport` cast (line 1704) with `assertHealthCapable(transport)` narrowing | +5 |
| `docs/L2/nexus-client.md` | Document readiness probe semantics; `HealthCapableNexusTransport` contract; WS/gRPC/pool out-of-scope rationale | +60 |

**Total: ~580 LOC (175 src + 345 test + 60 doc).**

(Larger than the original ~170 estimate because reviews correctly demanded real integration, type-system enforcement, and a readiness probe — not just a dead liveness API.)

## Tests (TDD — written before code)

`packages/lib/nexus-client/src/health.test.ts`:

1. `health() returns ok with policyStore="synced" when both probes succeed (read returns 200)`
2. `health() returns ok with policyStore="empty" when version ok and read returns 404` — tri-state distinguishes bootstrap state from failure
3. `health() returns error when version probe returns 503` — fail at liveness step
4. `health() returns error when read probe returns 503` — fail at readiness step
5. `health() returns error when read probe returns 401 (auth failure)`
5. `health() returns error on timeout shorter than default deadline`
6. `health() returns error on network failure`
7. `health() returns error on malformed response`
8. `health() probes execute within HEALTH_DEADLINE_MS not default deadline`

`packages/lib/nexus-client/src/assert-health-capable.test.ts`:

9. `assertHealthCapable narrows type when health is present`
10. `assertHealthCapable throws KoiError-shaped error when health is undefined`

`packages/meta/cli/src/__tests__/runtime-factory-health.test.ts`:

11. `telemetry mode: succeeds and logs warning on health() error` — local-first preserved
12. `telemetry mode: succeeds and logs info on health() ok with policyStore=synced`
13. `telemetry mode: succeeds and logs warning on policyStore=empty`
14. `fail-closed mode: throws on health() error`
15. `fail-closed mode: succeeds + warns on policyStore=empty (does NOT throw — empty is valid first-boot)`
16. `fail-closed-policy-required mode: throws on policyStore=empty`
17. `fail-closed-policy-required mode: succeeds on policyStore=synced`
18. `default mode is "telemetry" when only permissions wired (no audit sink)`
19. `default mode is "fail-closed" when audit sink wired` — derived from configured consumers
20. `explicit nexusBootMode override always wins`
21. `skips preflight when nexusTransport is undefined`
22. `fail-closed error message includes nexus error code`
23. `preflight runs before createNexusPermissionBackend wiring` (order matters)
24. `existing local-first golden test still passes` (telemetry-only setup) — regression guard

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
- [ ] **New `runtime-factory-health.test.ts` proves both boot modes:**
  - telemetry default succeeds + logs on health failure (local-first preserved)
  - fail-closed opt-in throws on health failure
  - existing local-first golden test still passes (regression guard)
- [ ] `bun run typecheck`, `bun run lint`, `bun run check:layers` clean
- [ ] PR description explains punted scope (gRPC/WS/pool) with rationale
- [ ] Issue #1401 closed by PR
