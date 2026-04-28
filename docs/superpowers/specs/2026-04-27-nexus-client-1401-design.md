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

/** Caller-supplied paths to probe (must match what consumers actually read). */
export interface NexusHealthOptions {
  /**
   * Read paths to probe. Defaults to ["koi/permissions/version.json",
   * "koi/permissions/policy.json"] — the standard permission backend paths.
   * Runtimes using a custom `policyPath` MUST pass their actual paths here,
   * otherwise the probe validates the wrong namespace and reports false readiness.
   */
  readonly readPaths?: readonly string[];
}

/**
 * Stronger contract — production transports MUST satisfy this.
 * `createHttpTransport` returns `HealthCapableNexusTransport`; runtime
 * startup accepts ONLY this type, so missing health is a compile error.
 */
export interface HealthCapableNexusTransport extends NexusTransport {
  readonly health: (opts?: NexusHealthOptions) => Promise<Result<NexusHealth, KoiError>>;
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
3. For each path in `opts.readPaths ?? DEFAULT_PROBE_PATHS`: `transport.call("read", { path }, { deadlineMs, nonInteractive: true })`. 200 ok or 404 → success (file-not-found is a transport-success signal). 5xx / network / auth → return error.
5. All calls go through `transport.call(...)` — local-bridge included.
6. **Health probes are non-interactive AND terminal-on-failure for the transport.** `nonInteractive: true` MUST cause local-bridge to:
   - reject the in-flight call locally (do not wait for OAuth)
   - **send `cancel` to the bridge subprocess** so the bridge-side request is unblocked (otherwise the single-request serializer stays wedged for queued calls)
   - **mark the transport `unusable` and close it** on this failure path (the bridge cannot cleanly resume from a cancelled auth flow within the per-call deadline; recreating from scratch is the safer recovery)

   Runtime behavior on terminal-transport result:
   - `telemetry` mode: log warning; **continue boot WITHOUT nexus-backed permissions/audit** (treats nexus as if it were not configured for the rest of the session). The runtime must record this state so subsequent calls don't try to use the dead transport.
   - `fail-closed-transport` / `fail-closed-policy`: throw at startup.

   HTTP transport has no auth flow; the flag is a no-op there and the transport stays usable.

   Why terminal: the local-bridge serializes one in-flight request and currently only unblocks when the bridge answers or the process exits. A recoverable nonInteractive rejection is not implementable without bridge-protocol changes that are out of scope. Marking the transport terminal is the only honest semantics that doesn't deadlock queued calls or silently extend the 5s deadline.
7. Per-call `deadlineMs: HEALTH_DEADLINE_MS = 5_000` overrides each transport's default.
8. On success: `{ ok: true, value: { ok: true, version, latencyMs, probed: ["version", "read:koi/permissions/version.json", "read:koi/permissions/policy.json"] } }`.
9. On failure: propagate `KoiError` via `mapNexusError`.

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
| `fail-closed-transport` | throw on transport failure for any of the 3 probes (version + version.json read + policy.json read); does NOT validate that policy files exist or that backend successfully activates remote policy |
| `fail-closed-policy` | throw on transport failure; throw on policy-activation failure (awaits `backend.ready`); centralized policy is required to serve traffic |

**⚠️ Security caveat for `fail-closed-transport`:** this gate only proves the transport can carry the read calls. Even with a 404 on `version.json`/`policy.json` the probe succeeds (file-not-found is a transport-success signal). And even when the files exist, parsing or backend `rebuildBackend` shape mismatch can still cause silent local-fallback. Operators who require centralized-policy *enforcement* must use `fail-closed-policy`, not `fail-closed-transport`. The two-name split is deliberate so this caveat cannot be papered over by mode-name optimism.

**Policy-activation check** (only in `fail-closed-policy`):

After the permission backend is created, the runtime `await`s `nexusPermBackend.ready` and inspects whether centralized policy actually activated (vs. fell back to local). The backend exposes activation status via its existing `ready` promise resolution and a documented status field. If activation failed (file 404, parse error, `rebuildBackend` shape mismatch, `supportsDefaultDenyMarker` mismatch), the runtime throws before exposing the runtime to requests. This closes the race the earlier draft had: requests cannot be served against the local fallback when policy-required mode is set.

**Audit-write runtime error surfacing (in scope this PR):**

`@koi/middleware-audit` already exposes an `onError` hook, and `runtime-factory.ts` already wires NDJSON and SQLite sinks through a poison-on-error pattern (`runtime-factory.ts:2526–2602` — `ndjsonPoisonError` accumulator, `onError` callback, post-flush rethrow). The Nexus audit sink is currently the only one wired without this pattern, which is what makes Nexus audit silently drop records on flush failure.

This PR adds the same poison-on-error wiring for `createNexusAuditSink`:

```ts
let nexusAuditPoisonError: unknown;
const nexusAuditSink = createNexusAuditSink({
  transport: nexusTransport,
  onError: (error: unknown) => {
    if (nexusAuditPoisonError === undefined) nexusAuditPoisonError = error;
    logger.error({ err: error }, "nexus audit sink write failed");
  },
  // … existing config …
});
// At session-end / explicit flush boundary, rethrow if poisoned (matches NDJSON pattern).
```

**Remaining gap (server-side, out of scope):** `health()` still does not probe audit *write* readiness — there is no non-side-effecting audit RPC on the Nexus server. The poison-on-error wiring closes the runtime observability gap (operators see failures via logs and the runtime fails fast on flush), but does not move detection to startup. A server-side `audit.ping` RPC would close that remaining gap; tracked as a separate Nexus server issue.

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

    // Step 1: transport health (what nexus-client can validate).
    // Pass the configured policyPath so the probe validates the right namespace.
    const policyBase = config.nexusPermissionsPath ?? "koi/permissions";
    const health = await config.nexusTransport.health({
      readPaths: [`${policyBase}/version.json`, `${policyBase}/policy.json`],
    });
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

**Backend API addition required** (`@koi/permissions-nexus`): `nexusPermBackend.isCentralizedPolicyActive(): boolean`.

**Semantics (matched exactly to current backend behavior):** returns true iff the **currently-serving backend** is a remote-policy backend. The current backend SKIPS failed/malformed/incompatible updates and keeps the previously-activated backend in place — it does not revert to local on a bad poll or a structurally-incompatible policy. Therefore:

| Backend state | `isCentralizedPolicyActive()` |
|---|---|
| First sync ever fails (no last-known-good to keep) — serving local fallback | `false` |
| First sync succeeds — serving remote policy | `true` |
| Subsequent sync fails (network/parse/rebuild — last-known-good preserved) | `true` (still serving remote) |
| Subsequent sync produces structurally-incompatible policy (skipped, last-known-good preserved) | `true` (still serving remote) |

The function reports what the backend is *actually serving right now*, not the success of the latest sync attempt. This preserves the existing availability contract: a bad rollout that the backend rejects does not demote a node to local rules.

`fail-closed-policy` checks this **once at startup** after `await backend.ready` completes — i.e., it asserts that the first sync produced a remote backend. Post-boot transient failures do not re-trigger the gate. The new mode adds a startup guarantee without changing steady-state behavior.

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
| `packages/lib/nexus-client/src/types.ts` | Add `NexusCallOptions` (deadlineMs, nonInteractive), `NexusHealthOptions` (readPaths), `NexusHealth`, optional `health` on `NexusTransport`, required `health` on `HealthCapableNexusTransport`; extend `call` signature with optional `opts` | +28 |
| `packages/lib/nexus-client/src/transport.ts` | HTTP impl: thread `opts.deadlineMs` into existing `AbortSignal.timeout`; implement `health(opts?)` — version probe + one `read` per `opts.readPaths` (default `koi/permissions/version.json` + `koi/permissions/policy.json`); discard read result bodies; return `HealthCapableNexusTransport` | +55 |
| `packages/lib/nexus-client/src/health.test.ts` | New: all probes ok → ok+probed lists each path; either read returns 404 → still ok; version 5xx → fail; any read 5xx → fail; read 401 → fail; per-call deadline honored; network error; malformed version response; nonInteractive flag set on all calls; **custom readPaths override default** (probes provided paths only) | +200 |
| `packages/lib/nexus-client/src/assert-health-capable.ts` | New: `assertHealthCapable` assertion function | +15 |
| `packages/lib/nexus-client/src/assert-health-capable.test.ts` | New: present narrows; missing throws | +25 |
| `packages/lib/nexus-client/src/index.ts` | Re-export `NexusHealth`, `HealthCapableNexusTransport`, `assertHealthCapable` | +3 |
| `packages/lib/fs-nexus/src/local-transport.ts` | (1) Per-call `opts.deadlineMs` — pending-request map tracks per-entry deadline; reaper rejects on expiry. (2) Per-call `opts.nonInteractive` — on `auth_required`: reject the in-flight call locally, **send `cancel` notification to bridge subprocess**, **mark transport unusable and close**. After this, all subsequent `transport.call(...)` returns `{ ok: false, error: { code: "TRANSPORT_CLOSED", … } }`. (3) Implement `health()` with the three probes through real subprocess stdio with `{ deadlineMs: 5000, nonInteractive: true }`; return `HealthCapableNexusTransport` | +110 |
| `packages/lib/fs-nexus/src/local-transport.test.ts` | New: per-call deadline rejects before transport default; nonInteractive=true on auth_required rejects locally AND sends cancel to bridge AND marks transport unusable; subsequent calls fail with TRANSPORT_CLOSED; queued calls don't deadlock after terminal failure; health success through subprocess; health failure when subprocess dead; health failure when stdio handshake broken | +160 |
| `packages/security/permissions-nexus/src/nexus-permission-backend.ts` | Add `isCentralizedPolicyActive(): boolean` — read-only query of currently-serving backend (true iff serving remote, regardless of latest sync outcome); preserves existing skip-bad-update behavior | +25 |
| `packages/security/permissions-nexus/src/nexus-permission-backend.test.ts` | New tests: false before any sync; false when first sync fails (404/parse/rebuild mismatch — no last-known-good); true after first successful sync; **stays true when subsequent sync fails** (last-known-good preserved); **stays true when subsequent sync produces incompatible policy** (skipped, last-known-good preserved) | +100 |
| `packages/meta/cli/src/runtime-factory.ts` | Type `nexusTransport` as `HealthCapableNexusTransport`; add `nexusBootMode` config field (default `"telemetry"`); wire transport-health preflight; **on telemetry-mode probe failure, skip nexus-backed permissions/audit wiring** (don't pass dead transport to consumers); in `fail-closed-policy` mode, await `nexusPermBackend.ready` and check `isCentralizedPolicyActive()` before exposing runtime; wire `createNexusAuditSink` through poison-on-error pattern matching NDJSON/SQLite sinks | +90 |
| `packages/meta/cli/src/__tests__/runtime-factory-nexus-audit-poison.test.ts` | New tests: `onError` accumulates first failure; subsequent flush rethrows poisoned error; success path does not poison; matches existing NDJSON pattern semantics | +90 |
| `packages/meta/cli/src/__tests__/runtime-factory-health.test.ts` | New tests covering all three modes + activation race coverage (see Tests section) | +200 |
| `packages/meta/cli/src/tui-command.ts` | Replace `as unknown as NexusTransport` cast (line 1704) with `assertHealthCapable(transport)` narrowing | +5 |
| `docs/L2/nexus-client.md` | Document readiness probe semantics; `HealthCapableNexusTransport` contract; WS/gRPC/pool out-of-scope rationale | +60 |

**Total: ~890 LOC (250 src + 580 test + 60 doc).**

(Larger than the original ~170 estimate because reviews correctly demanded real integration, type-system enforcement, and a readiness probe — not just a dead liveness API.)

## Tests (TDD — written before code)

`packages/lib/nexus-client/src/health.test.ts`:

1. `health() with default opts probes version + version.json + policy.json; returns ok with probed list when all succeed`
2. `health({ readPaths: ["custom/v.json"] }) probes only the supplied paths; default paths NOT probed`
3. `health() returns ok when any read returns 404 (transport works)`
4. `health() returns error when version probe returns 503`
5. `health() returns error when any read returns 503` — proves we don't stop after first read
6. `health() returns error when any read returns 401 (auth failure)`
7. `health() passes nonInteractive=true and deadlineMs on every transport.call`
8. `health() honors per-call deadline (rejects within HEALTH_DEADLINE_MS)`
5. `health() returns error on timeout shorter than default deadline`
6. `health() returns error on network failure`
7. `health() returns error on malformed response`
8. `health() probes execute within HEALTH_DEADLINE_MS not default deadline`

`packages/lib/nexus-client/src/assert-health-capable.test.ts`:

9. `assertHealthCapable narrows type when health is present`
10. `assertHealthCapable throws KoiError-shaped error when health is undefined`

`packages/meta/cli/src/__tests__/runtime-factory-health.test.ts`:

7b. `telemetry mode + terminal local-bridge failure: skips wiring nexus permissions and audit consumers; runtime still boots without nexus features`
7c. `telemetry mode + terminal local-bridge failure: subsequent calls do NOT use the dead transport`
7d. `runtime-factory passes configured policyPath to health() readPaths` (custom paths probed, not defaults)
8. `telemetry default: succeeds and logs warning on health() error` — local-first preserved
9. `telemetry: succeeds and logs info on transport ok`
10. `telemetry: does NOT await backend.ready` — preserves existing async semantics
11. `fail-closed-transport: throws on transport error`
12. `fail-closed-transport: does NOT await backend.ready` — only transport gate, no policy gate
13. `fail-closed-policy: awaits backend.ready before exposing runtime`
14. `fail-closed-policy: throws when first sync fails (no last-known-good) — file 404, no remote backend ever activated`
15. `fail-closed-policy: throws when first sync fails — parse error`
16. `fail-closed-policy: throws when first sync fails — rebuild shape mismatch`
17. `fail-closed-policy: succeeds when first sync succeeds (isCentralizedPolicyActive === true)`
17b. `fail-closed-policy: post-boot transient failure does NOT re-trigger gate — last-known-good remote policy preserved` (regression guard for availability)
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
