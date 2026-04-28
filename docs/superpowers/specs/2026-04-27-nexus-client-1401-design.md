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

/** Optional per-call options. */
export interface NexusCallOptions {
  /** Override transport's default deadline for this single call. */
  readonly deadlineMs?: number;
  /**
   * When true, transport MUST fail-fast on `auth_required` instead of
   * extending the deadline for OAuth. Set by health probes to prevent
   * startup stalls behind interactive auth. No-op for HTTP transport.
   */
  readonly nonInteractive?: boolean;
}

/**
 * Transport health result. Validates ONLY what nexus-client can know without
 * instantiating downstream consumers: TCP+TLS+JSON-RPC reachability and
 * version. Policy-activation readiness is the runtime's responsibility
 * (it owns the backend instance and can await `backend.ready`).
 */
export interface NexusHealth {
  readonly ok: true;
  readonly version: string;
  readonly latencyMs: number;
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
2. `transport.call("version", {}, { deadlineMs: HEALTH_DEADLINE_MS, nonInteractive: true })` — liveness: TCP+TLS+JSON-RPC reachable; capture version string.
3. `transport.call("read", { path: "koi/permissions/version.json" }, { deadlineMs, nonInteractive: true })` — exercises the read path used by every policy sync. Discard result; we only care that it returned a valid JSON-RPC envelope (200 ok or 404 — both prove the read code path works). 5xx / network / auth → return error.
4. All calls go through `transport.call(...)` — local-bridge included.
5. **Health probes are non-interactive.** `nonInteractive: true` MUST cause local-bridge to reject (not extend timeout for) `auth_required` notifications. Without this, an unauthenticated mount could stall startup behind interactive OAuth. HTTP transport has no auth flow; this flag is a no-op there.
6. Per-call `deadlineMs: HEALTH_DEADLINE_MS = 5_000` overrides each transport's default.
7. On success: `{ ok: true, value: { ok: true, version, latencyMs, probed: ["version", "read:koi/permissions/version.json"] } }`.
8. On failure: propagate `KoiError` via `mapNexusError`.

**Scope of `health()`:** transport-layer only — it validates that the JSON-RPC channel can carry the read calls that `createNexusPermissionBackend` will make. It does NOT claim that policy is "synced", that the policy backend will successfully activate, or that audit writes will succeed. Those are downstream concerns and belong to the runtime startup (next section), not to nexus-client.

**Why this scope is the right one:**

- `nexus-client` knows nothing about the permission backend's `rebuildBackend(policy)` activation rules or `supportsDefaultDenyMarker` matching. Earlier drafts that returned `policyStore: "synced"` overclaimed — a successful read+parse does not guarantee backend activation.
- The runtime owns the backend instance. Awaiting `backend.ready` and inspecting actual activation status is something only the runtime can do honestly.
- Splitting concerns this way keeps `nexus-client` honest and pushes the strongest readiness guarantees to where they can actually be made.

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

## Startup integration (telemetry by default, opt-in fail-closed-transport / fail-closed-policy)

The real production boundary is `packages/meta/cli/src/runtime-factory.ts:832` (`KoiRuntimeFactoryConfig.nexusTransport`). The runtime factory wires Nexus into `createNexusPermissionBackend` and `createNexusAuditSink`.

**Critical existing contract: local-first permissions.** `createNexusPermissionBackend` is documented as "local-first: TUI rules apply when Nexus has no policy or is unreachable." A golden test in `meta/runtime/src/__tests__/golden-replay.test.ts` proves this fallback. **A fail-closed startup gate would break this contract** and convert recoverable Nexus outages into total runtime unavailability. That is a regression.

**Decision: telemetry-by-default for everything; fail-closed-transport and fail-closed-policy are explicit opt-ins.**

Earlier drafts proposed making audit-wired runtimes default to `fail-closed-transport`. That was wrong: `health()` does NOT probe the audit write path (no non-side-effecting audit RPC exists today), so defaulting to fail-closed for audit gives a **false safety signal**. Better to be honest: telemetry default for everything, document the audit-write gap, and let operators opt in.

| Mode | Behavior |
|---|---|
| `telemetry` (default) | log on transport failure; log activation status; continue boot |
| `fail-closed-transport` | throw on transport failure; **does NOT validate centralized policy** — local-fallback may still apply if Nexus policy files are missing/malformed |
| `fail-closed-policy` | throw on transport failure; throw on policy-activation failure (awaits `backend.ready`); centralized policy is required to serve traffic |

**⚠️ Security caveat for `fail-closed-transport`:** the name implies stricter posture than it delivers. It only gates transport reachability — `createNexusPermissionBackend` will still fall back to local rules if `version.json`/`policy.json` are missing, malformed, or fail backend rebuild. Operators who require centralized-policy enforcement must use `fail-closed-policy`, not `fail-closed-transport`. The two-name split is deliberate so this caveat cannot be papered over by mode-name optimism.

**Policy-activation check** (only in `fail-closed-policy`):

After the permission backend is created, the runtime `await`s `nexusPermBackend.ready` and inspects whether centralized policy actually activated (vs. fell back to local). The backend exposes activation status via its existing `ready` promise resolution and a documented status field. If activation failed (file 404, parse error, `rebuildBackend` shape mismatch, `supportsDefaultDenyMarker` mismatch), the runtime throws before exposing the runtime to requests. This closes the race the earlier draft had: requests cannot be served against the local fallback when policy-required mode is set.

**Documented audit-write gap (in package README):**

> "Nexus audit write readiness is not probed at startup. A broken Nexus audit backend can pass `health()` and still drop compliance records — `createNexusAuditSink` and `createAuditMiddleware` currently swallow async flush failures with no observable signal (no `onError` hook, no drop counter today). Closing this gap requires (a) a Nexus server-side audit ping RPC for non-side-effecting probing, AND (b) a runtime `onError`/poison hook on the audit middleware so dropped writes become observable. Both are tracked as follow-up issues; this PR does NOT add either."

This is honest disclosure rather than pointing operators at observability surfaces that don't exist. Adding the `onError` hook is out of scope for this PR (it's an audit middleware change, not a nexus-client change), but the limitation is now documented in plain language so operators understand the gap rather than assuming `telemetry` mode plus existing tooling gives them audit reliability.

```ts
// packages/meta/cli/src/runtime-factory.ts
import type { HealthCapableNexusTransport } from "@koi/nexus-client";

type NexusBootMode = "telemetry" | "fail-closed-transport" | "fail-closed-policy";

interface KoiRuntimeFactoryConfig {
  // …
  readonly nexusTransport?: HealthCapableNexusTransport | undefined;
  /**
   * Behavior when startup health probe fails or policy fails to activate.
   * Default: "telemetry" (always — does NOT vary by configured consumers;
   * audit-write readiness is not probed and an audit-driven default would
   * give false safety).
   *
   * - "telemetry": log on transport failure; continue boot; preserves
   *   existing local-first contract for permissions.
   * - "fail-closed-transport": throw on transport failure. Does NOT validate
   *   that centralized policy activated — local-fallback may still apply.
   *   See security caveat in design doc.
   * - "fail-closed-policy": throw on transport failure OR policy-activation
   *   failure (awaits backend.ready and inspects isCentralizedPolicyActive()).
   *   Required for deployments that need centralized policy enforced at boot.
   */
  readonly nexusBootMode?: NexusBootMode | undefined;
}

export async function createKoiRuntime(config: KoiRuntimeFactoryConfig) {
  // … existing setup …
  if (config.nexusTransport !== undefined) {
    const mode: NexusBootMode = config.nexusBootMode ?? "telemetry";

    // Step 1: transport health (what nexus-client can validate)
    const health = await config.nexusTransport.health();
    if (!health.ok) {
      const msg = `Nexus transport unhealthy: ${health.error.message} (code=${health.error.code})`;
      if (mode === "telemetry") logger.warn({ err: health.error }, msg);
      else throw new Error(msg, { cause: health.error });
    } else {
      logger.info({ latencyMs: health.value.latencyMs, version: health.value.version,
                    probed: health.value.probed }, "nexus transport ok");
    }

    // Step 2: build permission backend (existing wiring)
    const nexusPermBackend = createNexusPermissionBackend({ transport, /* … */ });

    // Step 3: policy-activation check — ONLY in fail-closed-policy mode
    if (mode === "fail-closed-policy") {
      await nexusPermBackend.ready;  // wait for first sync to complete (or fail)
      if (!nexusPermBackend.isCentralizedPolicyActive()) {
        throw new Error(
          "Nexus centralized policy not active after sync (file missing, parse error, or backend rebuild failed); " +
          "fail-closed-policy mode requires active centralized policy",
        );
      }
    }
    // telemetry / fail-closed-transport modes: do NOT await ready (preserves existing async semantics)
  }
  // … then build audit sink and continue …
}
```

**Backend API addition required** (`@koi/permissions-nexus`): `nexusPermBackend.isCentralizedPolicyActive(): boolean`. Returns true iff the most recent sync produced a successfully-activated remote policy backend (not the local-fallback path). This is a read-only query of internal activation state and is needed to honor `fail-closed-policy` honestly.

**Type-system enforcement:** field typed as `HealthCapableNexusTransport`. Production transports (`createHttpTransport`, fs-nexus `local-bridge`) must return this. TypeScript rejects a base `NexusTransport`. The `as unknown as NexusTransport` cast in `tui-command.ts:1704` becomes `assertHealthCapable(transport)`.

**Why this is the right policy:**

- Default mode preserves the existing local-first contract — no regression
- Operators get visibility into Nexus health via logs at every startup
- Compliance/security deployments opt in to `fail-closed-transport` or `fail-closed-policy` explicitly
- The golden test for local-first fallback continues to pass unchanged

`assertHealthCapable<T extends NexusTransport>(t: T): asserts t is T & HealthCapableNexusTransport` is the assertion helper.

## Files

| File | Change | Est LOC |
|---|---|---|
| `packages/lib/nexus-client/src/types.ts` | Add `NexusCallOptions` (deadlineMs, nonInteractive), `NexusHealth` (transport-only fields), optional `health` on `NexusTransport`, required `health` on `HealthCapableNexusTransport`; extend `call` signature with optional `opts` | +22 |
| `packages/lib/nexus-client/src/transport.ts` | HTTP impl: thread `opts.deadlineMs` into existing `AbortSignal.timeout`; implement `health()` with two transport probes (version + read koi/permissions/version.json); discard read result body; return `HealthCapableNexusTransport` | +45 |
| `packages/lib/nexus-client/src/health.test.ts` | New: both probes ok → ok with version+latency; read returns 404 → still ok (transport works); version 5xx → fail; read 5xx → fail; read 401 → fail; per-call deadline honored; network error; malformed version response; nonInteractive flag set on all calls | +160 |
| `packages/lib/nexus-client/src/assert-health-capable.ts` | New: `assertHealthCapable` assertion function | +15 |
| `packages/lib/nexus-client/src/assert-health-capable.test.ts` | New: present narrows; missing throws | +25 |
| `packages/lib/nexus-client/src/index.ts` | Re-export `NexusHealth`, `HealthCapableNexusTransport`, `assertHealthCapable` | +3 |
| `packages/lib/fs-nexus/src/local-transport.ts` | (1) Add per-call `opts.deadlineMs` support: pending-request map tracks per-entry deadline; reaper rejects on expiry. (2) Add per-call `opts.nonInteractive` support: when true, `auth_required` notification rejects the in-flight call immediately instead of clearing the per-call timer. (3) Implement `health()` calling both transport probes through the real subprocess stdio channel with `{ deadlineMs: 5000, nonInteractive: true }`; return `HealthCapableNexusTransport` | +85 |
| `packages/lib/fs-nexus/src/local-transport.test.ts` | New: per-call deadline rejects before transport default; nonInteractive=true rejects on auth_required without extending deadline; health success through subprocess; health failure when subprocess dead; health failure when stdio handshake broken | +120 |
| `packages/security/permissions-nexus/src/nexus-permission-backend.ts` | Add `isCentralizedPolicyActive(): boolean` method; tracks whether last sync produced a successfully-rebuilt remote backend (vs. fell back to local) | +30 |
| `packages/security/permissions-nexus/src/nexus-permission-backend.test.ts` | New tests: returns false before first sync; true after successful sync; false after sync that fell back (file 404, parse error, rebuildBackend mismatch, supportsDefaultDenyMarker mismatch) | +80 |
| `packages/meta/cli/src/runtime-factory.ts` | Type `nexusTransport` as `HealthCapableNexusTransport`; add `nexusBootMode` config field (default `"telemetry"`); wire transport-health preflight; in `fail-closed-policy` mode, await `nexusPermBackend.ready` and check `isCentralizedPolicyActive()` before exposing runtime | +50 |
| `packages/meta/cli/src/__tests__/runtime-factory-health.test.ts` | New tests covering all three modes + activation race coverage (see Tests section) | +200 |
| `packages/meta/cli/src/tui-command.ts` | Replace `as unknown as NexusTransport` cast (line 1704) with `assertHealthCapable(transport)` narrowing | +5 |
| `docs/L2/nexus-client.md` | Document readiness probe semantics; `HealthCapableNexusTransport` contract; WS/gRPC/pool out-of-scope rationale | +60 |

**Total: ~660 LOC (200 src + 400 test + 60 doc).**

(Larger than the original ~170 estimate because reviews correctly demanded real integration, type-system enforcement, and a readiness probe — not just a dead liveness API.)

## Tests (TDD — written before code)

`packages/lib/nexus-client/src/health.test.ts`:

1. `health() returns ok with version + latency + probed when both probes succeed`
2. `health() returns ok when read returns 404 (transport works; activation status is runtime's job)`
3. `health() returns error when version probe returns 503` — liveness fail
4. `health() returns error when read returns 503` — transport fail
5. `health() returns error when read returns 401 (auth failure)`
6. `health() passes nonInteractive=true and deadlineMs on every transport.call`
7. `health() honors per-call deadline (rejects within HEALTH_DEADLINE_MS)`
5. `health() returns error on timeout shorter than default deadline`
6. `health() returns error on network failure`
7. `health() returns error on malformed response`
8. `health() probes execute within HEALTH_DEADLINE_MS not default deadline`

`packages/lib/nexus-client/src/assert-health-capable.test.ts`:

9. `assertHealthCapable narrows type when health is present`
10. `assertHealthCapable throws KoiError-shaped error when health is undefined`

`packages/meta/cli/src/__tests__/runtime-factory-health.test.ts`:

8. `telemetry default: succeeds and logs warning on health() error` — local-first preserved
9. `telemetry: succeeds and logs info on transport ok`
10. `telemetry: does NOT await backend.ready` — preserves existing async semantics
11. `fail-closed-transport: throws on transport error`
12. `fail-closed-transport: does NOT await backend.ready` — only transport gate, no policy gate
13. `fail-closed-policy: awaits backend.ready before exposing runtime`
14. `fail-closed-policy: throws when isCentralizedPolicyActive() === false (file 404)`
15. `fail-closed-policy: throws when isCentralizedPolicyActive() === false (parse error)`
16. `fail-closed-policy: throws when isCentralizedPolicyActive() === false (rebuild mismatch)`
17. `fail-closed-policy: succeeds when isCentralizedPolicyActive() === true`
18. `fail-closed-policy: NO permission check executes against local backend before policy ready` — race coverage
19. `default mode is "telemetry" regardless of audit wiring` (honest contract)
20. `explicit nexusBootMode override always wins`
21. `skips preflight when nexusTransport is undefined`
22. `fail-closed-transport / fail-closed-policy error messages include nexus error code`
23. `existing local-first golden test still passes (telemetry default)` — regression guard

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
