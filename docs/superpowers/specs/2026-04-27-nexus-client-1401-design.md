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

/**
 * Transport kind discriminator. Public part of the contract — runtime
 * code branches on this for probe strategy selection (e.g., disposable
 * vs. session probe for local-bridge). Adding new transport kinds is
 * a public-API change.
 */
export type NexusTransportKind = "http" | "local-bridge";

/** Base transport — minimal surface, satisfied by tests/mocks/fixtures. */
export interface NexusTransport {
  readonly kind: NexusTransportKind;
  readonly call: <T>(
    method: string,
    params: Record<string, unknown>,
    opts?: NexusCallOptions,  // per-call deadline / nonInteractive override
  ) => Promise<Result<T, KoiError>>;
  /** OPTIONAL on the base type so test fixtures don't need stubs. */
  readonly health?: (opts?: NexusHealthOptions) => Promise<Result<NexusHealth, KoiError>>;
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
 * Stronger contract — used ONLY for probe transports. The runtime accepts
 * `NexusTransport` (base) for the long-lived session and gets health via
 * a probe path:
 *   - HTTP: the long-lived transport IS itself HealthCapable (HTTP is safe to
 *     probe in place); runtime-factory uses it as the probe directly.
 *   - local-bridge: long-lived session is BASE NexusTransport (no `health()`
 *     exposed — probing it is unsafe per the bridge constraints documented
 *     above). Probing happens via a disposable `HealthCapableNexusTransport`
 *     constructed by `nexusProbeFactory`.
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
6. **Local-bridge probing is constrained.** The fs-nexus `local-bridge` cannot be cleanly probed in-place without risk: its subprocess serializes one in-flight call, has no protocol-level cancel that doesn't poison the channel, and a wedged auth flow blocks every queued call. The two honest options for probing have unacceptable downsides under fail-closed semantics:

   | Probe target | Pros | Cons under fail-closed |
   |---|---|---|
   | Live session transport | Real validation | Auth blip wedges session — startup-only probe causes non-recoverable transport failure for the whole run |
   | Disposable fresh subprocess | Session safe | Validates spawn config + code paths only, NOT the live session — fail-closed guarantee would be misleading |

   **Resolution:**

   - **HTTP transport:** probe in place (no auth flow risk). All boot modes supported.
   - **local-bridge + `telemetry` (default):** probe via a disposable subprocess **when caller provides `nexusProbeFactory`**. If absent, probe is **skipped** (advisory log only); boot continues normally — preserves backward compatibility for existing callers that haven't been updated. The transport object never exposes spawn config or credentials; the factory is a sealed capability passed by the caller (e.g., `tui-command.ts`) that constructs the disposable probe with its own copy of the spawn config.
   - **local-bridge + `fail-closed-transport` / `fail-closed-remote-policy-loaded`:** **NOT SUPPORTED.** Throws a config validation error at startup. Both implementation options would produce wrong behavior (session-wedge or false-guarantee). Once the bridge gains a non-poisoning cancel/reset (out of scope), this restriction can be lifted. Operators needing fail-closed must use HTTP transport.

   API surface:
   - `createLocalBridgeTransport(config)` → long-lived session transport (no probe support exposed)
   - `createLocalBridgeProbeTransport(spawnConfig)` → disposable transport that closes after one `health()` call. Caller passes spawn config; transport object does NOT retain it after spawn.
   - `KoiRuntimeFactoryConfig.nexusProbeFactory?: () => HealthCapableNexusTransport` — caller-supplied factory for probe construction. Recommended when `nexusTransport.kind === "local-bridge"` AND `nexusBootMode === "telemetry"`. If absent, the probe is skipped (advisory log only); boot continues. Not stored on the runtime; called once during boot then discarded.

   This eliminates the credential-leak risk (transport is opaque; spawn secrets live in a sealed capability) AND avoids making misleading fail-closed claims for local-bridge.
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

## Startup integration (telemetry by default, opt-in fail-closed-transport / fail-closed-remote-policy-loaded)

The real production boundary is `packages/meta/cli/src/runtime-factory.ts:832` (`KoiRuntimeFactoryConfig.nexusTransport`). The runtime factory wires Nexus into `createNexusPermissionBackend` and `createNexusAuditSink`.

**Critical existing contract: local-first permissions.** `createNexusPermissionBackend` is documented as "local-first: TUI rules apply when Nexus has no policy or is unreachable." A golden test in `meta/runtime/src/__tests__/golden-replay.test.ts` proves this fallback. **A fail-closed startup gate would break this contract** and convert recoverable Nexus outages into total runtime unavailability. That is a regression.

**Decision: telemetry-by-default for everything; fail-closed-transport and fail-closed-remote-policy-loaded are explicit opt-ins.**

Earlier drafts proposed making audit-wired runtimes default to `fail-closed-transport`. That was wrong: `health()` does NOT probe the audit write path (no non-side-effecting audit RPC exists today), so defaulting to fail-closed for audit gives a **false safety signal**. Better to be honest: telemetry default for everything, document the audit-write gap, and let operators opt in.

| Mode | Behavior |
|---|---|
| `telemetry` (default) | log on transport failure; log activation status; continue boot |
| `fail-closed-transport` | throw on transport failure for any of the 3 probes (version + version.json read + policy.json read); does NOT validate that policy files exist or that backend successfully activates remote policy |
| `fail-closed-remote-policy-loaded` | throw on transport failure; throw on first-sync policy-activation failure (awaits `backend.ready`). **STARTUP GATE ONLY, REMOTE-LOAD ONLY** — proves remote policy was loaded at boot. Does NOT prove remote policy will be enforced for every check: per existing composition (`runtime-factory.ts:1797-1806`), Nexus backend chains to local TUI on `ask`/no-opinion results, so queries not matched by remote policy still execute under local rules. Does NOT enforce ongoing freshness either: last-known-good remote policy continues to be served after sync failures. Operators needing strict centralized enforcement (no local fallback for unmatched queries) need a permission-composition change tracked separately. |

**⚠️ Security caveat — no mode in this PR provides centralized-policy enforcement.** `fail-closed-transport` only proves the transport can carry read calls. `fail-closed-remote-policy-loaded` only proves remote policy was loaded at boot. Neither prevents local-rule fallback for queries the remote policy doesn't match (existing permission composition chains to local TUI on `ask`/no-opinion). The mode names deliberately reflect what they actually gate (`-transport`, `-remote-policy-loaded`) rather than implying enforcement they don't deliver. **Operators requiring strict centralized enforcement (no local fallback for unmatched queries) must wait for the permission-composition change tracked separately** — neither mode here is sufficient for that requirement.

**Policy-activation check** (only in `fail-closed-remote-policy-loaded`):

After the permission backend is created, the runtime `await`s `nexusPermBackend.ready` and inspects whether centralized policy actually activated (vs. fell back to local). The backend exposes activation status via its existing `ready` promise resolution and a documented status field. If activation failed (file 404, parse error, `rebuildBackend` shape mismatch, `supportsDefaultDenyMarker` mismatch), the runtime throws before exposing the runtime to requests. This closes the race the earlier draft had: requests cannot be served against the local fallback when policy-required mode is set.

**Audit-write runtime error surfacing (opt-in, in scope this PR):**

`@koi/middleware-audit` already exposes an `onError` hook, and `runtime-factory.ts` already wires NDJSON and SQLite sinks through a poison-on-error guard pattern (`runtime-factory.ts:2526–2602`). The Nexus audit sink is currently wired without that pattern, so Nexus audit silently drops records on flush failure.

**Critical: the poison-guard pattern is fail-stop on first failure.** Wiring it unconditionally would turn the default `telemetry` boot mode into fail-stop on the first Nexus audit hiccup — a behavior regression. Therefore the guard is **opt-in via a separate config flag**, orthogonal to `nexusBootMode`:

```ts
interface KoiRuntimeFactoryConfig {
  // …
  /**
   * When true, wire the Nexus audit sink through the same poison-on-error
   * guard used by NDJSON/SQLite sinks: first failure latches; subsequent
   * `log()` calls throw; every middleware flush boundary rethrows.
   *
   * Default: false (best-effort, matches current Nexus audit behavior).
   * Operators who require audit durability opt in explicitly.
   *
   * Independent of nexusBootMode — boot-mode controls the startup probe;
   * this controls runtime audit error semantics.
   */
  readonly nexusAuditPoisonOnError?: boolean | undefined;
}
```

When `nexusAuditPoisonOnError === true`, the runtime hooks Nexus sink errors into the **same runtime-level poison accumulator** that NDJSON/SQLite already use (`runtime-factory.ts:2526–2602`). A sink-only wrapper would be weaker than the existing pattern: NDJSON/SQLite poison is checked at every middleware admission boundary (`onSessionStart`, `onBeforeTurn`, `wrapModelCall`, `wrapToolCall`, end-of-session flush), so new work is synchronously refused once durability has failed. A pure sink wrapper only fails the next `log()` / `flush()` call, leaving model/tool activity proceeding past the failure point.

**The poison flag MUST be a runtime-level shared accumulator, not a per-sink wrapper.**

Implementation: extend the existing accumulator pattern in `runtime-factory.ts` to also accept Nexus sink errors:

**Accumulator unification (prerequisite — must land in this PR):** `runtime-factory.ts` today has TWO separate accumulators — `ndjsonPoisonError` AND `sqlitePoisonError` — each latched independently and checked independently at admission boundaries. Hooking Nexus into only one would leave a gap: a Nexus failure couldn't surface through the SQLite admission path, and vice versa. **This PR collapses both into a single `auditPoisonError` accumulator** (atomic find/replace plus a single check at each admission boundary). Without this collapse, the parity claim below is unimplementable. NDJSON-only or SQLite-only deployments are unaffected (the accumulator is single-writer-per-sink-kind in practice; unification just removes the artificial split).

```ts
// post-unification pattern (NDJSON, SQLite, and Nexus all share one accumulator)
let auditPoisonError: unknown;  // SHARED accumulator — replaces both
                                // ndjsonPoisonError AND sqlitePoisonError

const ndjsonSink = createNdjsonAuditSink({
  // … existing config …
  onError: (err) => { if (auditPoisonError === undefined) auditPoisonError = err; },
});
const sqliteSink = createSqliteAuditSink({
  // … existing config …
  onError: (err) => { if (auditPoisonError === undefined) auditPoisonError = err; },  // unified
});

// NEW: route Nexus sink errors into the same accumulator (only when opted in)
if (config.nexusTransport !== undefined && config.nexusAuditPoisonOnError === true) {
  auditSinks.push(createNexusAuditSink({
    transport: config.nexusTransport,
    onError: (err) => {
      if (auditPoisonError === undefined) auditPoisonError = err;
      logger.error({ err }, "nexus audit sink poisoned");
    },
  }));
} else if (config.nexusTransport !== undefined) {
  // best-effort (default): log only, do NOT touch shared poison accumulator
  auditSinks.push(createNexusAuditSink({
    transport: config.nexusTransport,
    onError: (err) => logger.warn({ err }, "nexus audit write failed (best-effort)"),
  }));
}

// Existing middleware admission guards (no change — they already check auditPoisonError
// at onSessionStart / onBeforeTurn / wrapModelCall / wrapToolCall / shutdown flush)
// now ALSO catch Nexus failures because they share the accumulator.
```

This means:

- **No new wrapper module needed** — the existing runtime-level guard pattern is the right abstraction
- **No spec drift between sink kinds** — Nexus poisoning behaves exactly like NDJSON/SQLite poisoning at every admission boundary
- **Nexus best-effort mode is preserved** — when `nexusAuditPoisonOnError !== true`, Nexus errors stay out of the shared accumulator and never trigger admission denial

**Honest semantics — fail-stop at admission boundaries, observability at log boundaries:**

Background flush failure → `onError` fires → accumulator latched → operator sees error log immediately. Next admission boundary (`onSessionStart`/`onBeforeTurn`/`wrapModelCall`/`wrapToolCall`) inspects accumulator and refuses. The first failing flush's enqueued write may have been lost, but no subsequent model or tool activity proceeds against a known-failed sink. This matches NDJSON/SQLite exactly.

**The previous `createPoisonGuardedNexusAuditSink` helper is dropped** — runtime-factory hooks the existing pattern directly. Less code, no duplicate guard surface, no risk of helper-vs-runtime divergence.

**Default (telemetry mode, `nexusAuditPoisonOnError` unset):** Nexus audit remains best-effort. Failures are logged via `onError` but do not abort writes or rethrow at flush. Same observable behavior as today.

**Opt-in (`nexusAuditPoisonOnError: true`):** Full guard model — first failure latches, subsequent `log()` calls throw, every middleware flush boundary rethrows. Matches NDJSON/SQLite semantics. Compatible with any `nexusBootMode`.

**Compliance-recorder coverage (in scope this PR):**

The Nexus audit sink is wired into TWO middleware paths in `runtime-factory.ts`:

1. **Audit middleware sink** (`createAuditMiddleware({ sink: nexusSink })`) — failures here flow through `nexus-sink`'s `onError` config and (when opted in) the shared `auditPoisonError` accumulator described above.
2. **Compliance recorder** (`createAuditSinkComplianceRecorder(nexusSink, { sessionId, onError })`) at `runtime-factory.ts:3058-3059` — this is a SEPARATE write path with its own failure policy. NDJSON and SQLite compliance recorders use `onError: process.exit(1)` (synchronous termination because compliance writes are fire-and-forget and there's no other way to guarantee no further work runs after a compliance failure). The current Nexus compliance recorder is wired with NO `onError` callback, defaulting to silent.

This PR brings Nexus compliance-recorder failure handling to **NDJSON/SQLite parity** — but only when the operator opts in. Three modes:

| `nexusAuditPoisonOnError` | Audit middleware sink | Compliance recorder |
|---|---|---|
| `false` (default) | best-effort log | best-effort log (NEW: was silent) |
| `true` | shared poison accumulator + admission deny | `process.exit(1)` (matches NDJSON/SQLite) |

Concretely in `runtime-factory.ts`:

```ts
complianceRecorders.push(
  createAuditSinkComplianceRecorder(nexusSink, {
    sessionId: getLiveSessionId,
    onError: config.nexusAuditPoisonOnError === true
      ? (error) => {
          console.error("[koi/cli] nexus compliance sink write failed — terminating:", error);
          process.exit(1);
        }
      : (error) => logger.warn({ err: error }, "nexus compliance sink write failed (best-effort)"),
  }),
);
```

This closes the parity gap: in `nexusAuditPoisonOnError: true` mode, both audit-middleware writes AND compliance-recorder writes have fail-fast behavior matching NDJSON/SQLite.

**Sink-side change (always applies):**

`NexusAuditSinkConfig` does NOT currently expose an `onError` field — the existing config has only `transport`, `basePath`, `batchSize`, `flushIntervalMs`. This PR **adds** `onError?: (err: unknown) => void` to the public API in `packages/security/audit-sink-nexus/src/config.ts`. Without this, the wrapper has no observable signal for interval-triggered flush failures and the silent-drop bug remains.

`packages/security/audit-sink-nexus/src/nexus-sink.ts` then:
- Removes silent `.catch(() => {})` on `startFlush()`
- Routes failures from interval-triggered, size-triggered, AND explicit `flush()` paths through `config.onError?.(err)`
- Tested at all three trigger points to prove no path silently drops

This sink-side change is correct regardless of whether the operator opts into poison-guard — silent swallowing is a bug. Best-effort mode (default) gets logged warnings; poison-guard mode (opt-in) gets latch + rethrow.

**Known limitation — local-bridge + Nexus audit poison-on-error wedge (documented, not fixed in this PR):**

When `nexusTransport.kind === "local-bridge"` AND `nexusAuditPoisonOnError === true`, the FIRST Nexus audit write goes through the same long-lived local-bridge subprocess that serves permission sync and consumer calls. If that first write hits `auth_required` before user activity has established auth state, the bridge wedges the serialized session — the same class of failure the boot probe avoids. The audit write eventually fails, latches `auditPoisonError`, and admission boundaries deny — but the bridge session may already be unusable for permissions/consumer calls, so the "fail-stop on poison" guarantee partially overlaps with full-session unavailability.

**Hard rejection (config validation):** the runtime THROWS at boot if `nexusTransport.kind === "local-bridge" && nexusAuditPoisonOnError === true`. There is no isolation mechanism for the shared subprocess in this PR; permitting the combination would knowingly ship a poison-on-poison failure mode (audit error wedges session → permission sync ALSO wedged → consumer calls also wedged, all under "fail-stop on audit failure" framing that is misleading). Operators wanting fail-stop audit on Nexus MUST use HTTP transport. The error message names the conflict and the resolution.

**Out of scope here:** an `auditDeferInitialFlush` mode for local-bridge (analogous to `deferInitialSync` for permissions) would let audit writes queue until the first user-driven call unwedges auth. Tracked separately; not blocking this PR because (a) operators in this combination already accept best-effort by default, and (b) the runtime warning makes the constraint explicit.

**Remaining gap (server-side, out of scope):** `health()` still does not probe audit *write* readiness — no non-side-effecting audit RPC exists on the Nexus server. The opt-in poison-guard plus sink-side fix close the runtime observability and propagation gaps; they do not move detection to startup. A server-side `audit.ping` RPC would close that remaining gap; tracked as a separate Nexus server issue.

```ts
// packages/meta/cli/src/runtime-factory.ts
import type { HealthCapableNexusTransport } from "@koi/nexus-client";

type NexusBootMode = "telemetry" | "fail-closed-transport" | "fail-closed-remote-policy-loaded";

interface KoiRuntimeFactoryConfig {
  // …
  /**
   * Long-lived session transport. Typed as base `NexusTransport` because
   * local-bridge transports don't expose health (probing the live session
   * is unsafe). HTTP transports happen to also satisfy
   * `HealthCapableNexusTransport`, but the field type stays at the base
   * to keep both paths uniform.
   */
  readonly nexusTransport?: NexusTransport | undefined;
  /**
   * NFS path prefix under which the Nexus permission backend reads
   * `version.json` and `policy.json`. Defaults to "koi/permissions".
   * MUST be threaded into BOTH `createNexusPermissionBackend({ policyPath })`
   * (the existing backend config field) AND the `health()` probe's `readPaths`
   * so the readiness check validates the exact same namespace the backend
   * will read. Mismatch produces false readiness signals.
   */
  readonly nexusPolicyPath?: string | undefined;
  /**
   * Caller-supplied factory for constructing a disposable probe transport.
   * Recommended when `nexusTransport.kind === "local-bridge"` and
   * `nexusBootMode === "telemetry"`. If absent, the probe is skipped
   * (advisory log only) and boot continues — preserves backward compatibility
   * for existing local-bridge callers that haven't been updated.
   * Called once during boot, result is closed after the probe. Secrets stay
   * in this sealed capability — the long-lived transport never holds them.
   * Ignored for HTTP transport (probe in place).
   */
  readonly nexusProbeFactory?: (() => HealthCapableNexusTransport) | undefined;
  /**
   * When true, wire Nexus audit sink through poison-on-error guard.
   * Default false (best-effort, matches current behavior).
   * Independent of nexusBootMode — orthogonal concern.
   */
  readonly nexusAuditPoisonOnError?: boolean | undefined;
  /**
   * REQUIRED when `nexusTransport` is set. Mirrors `nexusPermissionsEnabled`:
   *   - true  → wire `createNexusAuditSink` (existing v2 behavior).
   *   - false → SKIP Nexus audit sink; local sinks (NDJSON/SQLite) unaffected.
   * Runtime throws if `nexusTransport` set and unset. Migration is a one-line
   * config change; existing implicit-enable deployments set true.
   */
  readonly nexusAuditEnabled?: boolean | undefined;
  /**
   * REQUIRED only when `nexusAuditEnabled === true && nexusTransport.kind === "local-bridge"`.
   * Forces explicit operator decision rather than silent degradation:
   *   - "require"    → wire Nexus audit sink (acknowledges wedge risk)
   *   - "local-only" → skip Nexus sink; runtime asserts at least one local
   *                    sink (NDJSON or SQLite) is configured, else throws
   *   - "disabled"   → skip Nexus sink with no fallback assertion
   * Not consulted when `nexusAuditEnabled === false` (audit not wanted at all)
   * or when transport is HTTP (no wedge surface). This scoping prevents
   * existing local-bridge boots that don't use Nexus audit from breaking.
   */
  readonly nexusAuditMode?: "require" | "local-only" | "disabled" | undefined;
  /**
   * REQUIRED when `nexusTransport` is set. Forces explicit operator decision
   * rather than silent downgrade or silent enablement:
   *   - true  → wire `createNexusPermissionBackend` (existing v2 behavior).
   *   - false → SKIP Nexus permissions; permission checks served by local
   *             TUI rules only. Used by audit-only deployments.
   * Runtime throws at config validation if `nexusTransport` is set and this
   * field is unset. Existing deployments that already wired Nexus permissions
   * MUST set `true` on upgrade — the migration is a one-line config change
   * with an actionable error message, NOT a silent behavior change.
   */
  readonly nexusPermissionsEnabled?: boolean | undefined;
  /**
   * Acknowledgment to use Nexus permissions on local-bridge transport.
   * Default false → throws at config validation. The first policy sync issues
   * read(version.json|policy.json) on the shared subprocess; if auth is not
   * yet established the call hits `auth_required` and wedges the serialized
   * session, taking permission sync AND consumer calls down. There is no
   * in-band cancel/reset on the bridge protocol today. Set true only for
   * dev/test where the user authenticates before any boot work — NOT for
   * production. Use HTTP transport for production Nexus permissions.
   */
  readonly nexusPermissionsOnLocalBridgeAck?: boolean | undefined;
  /**
   * Polling interval for the Nexus permission backend (ms).
   * Default: 30_000. Set 0 to disable (incompatible with local-bridge +
   * telemetry, which defers initial sync to the timer — runtime throws at
   * config validation).
   */
  readonly nexusSyncIntervalMs?: number | undefined;
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
   * - "fail-closed-remote-policy-loaded": throw on transport failure OR first-sync
   *   policy-load failure (awaits backend.ready and inspects
   *   isCentralizedPolicyActive()). STARTUP GATE, REMOTE-LOAD ONLY — proves
   *   remote policy was loaded at boot. Does NOT prevent local-rule fallback
   *   for queries not matched by remote policy (existing composition chains
   *   to local TUI on ask/no-opinion). Does NOT enforce ongoing freshness.
   */
  readonly nexusBootMode?: NexusBootMode | undefined;
}

export async function createKoiRuntime(config: KoiRuntimeFactoryConfig) {
  // … existing setup …
  if (config.nexusTransport !== undefined) {
    const mode: NexusBootMode = config.nexusBootMode ?? "telemetry";
    const policyBase = config.nexusPolicyPath ?? "koi/permissions";

    // Step 1: probe transport health.
    //
    // Local-bridge probing is constrained by two realities:
    //   - probing the live session can be poisoned by an auth blip
    //     (no protocol-level cancel exists today)
    //   - probing a disposable subprocess validates spawn + code paths
    //     but NOT the actual session instance state
    //
    // Strategy:
    //   - HTTP transport: probe in place (no auth flow risk).
    //   - local-bridge + telemetry mode: probe via a disposable subprocess
    //     constructed by a SEPARATE FACTORY passed in via config.
    //     The transport object NEVER exposes spawn config / credentials.
    //   - local-bridge + fail-closed-* modes: NOT SUPPORTED in this PR.
    //     We throw a config validation error at startup. The honest options
    //     ("probe session and risk wedge" vs "probe disposable and lie about
    //     guarantee") both have unacceptable failure modes. Until the bridge
    //     gains a non-poisoning cancel/reset, fail-closed-* is HTTP-only.
    // Preflight: fail-closed-* + local-bridge is unsupported (no honest
    // implementation possible per design above).
    if (config.nexusTransport.kind === "local-bridge" && mode !== "telemetry") {
      throw new Error(
        `nexusBootMode=${mode} is not supported for local-bridge transports. ` +
        `Use HTTP transport or nexusBootMode="telemetry". ` +
        `(Local-bridge cannot be probed without risking session wedge on auth challenges; ` +
        `probing a disposable subprocess would not validate the live session, so the ` +
        `fail-closed-* guarantee would be misleading.)`,
      );
    }

    // Pick probe transport:
    //   - HTTP: the session itself satisfies HealthCapable; probe in place
    //   - local-bridge + factory provided: use factory (disposable subprocess)
    //   - local-bridge + factory absent: SKIP probe entirely (advisory log only)
    //     This preserves backward compatibility for existing local-bridge boots
    //     that haven't been updated to provide the factory yet. Telemetry mode
    //     is advisory anyway, so skipping is honest about what we don't know.
    let probeTransport: HealthCapableNexusTransport | undefined;
    if (config.nexusTransport.kind === "http") {
      // Base NexusTransport keeps health optional for fixture compat. Production
      // HTTP transports MUST provide it (createHttpTransport always returns
      // HealthCapableNexusTransport). Guard rather than blind-cast to avoid
      // TypeError on a structurally-valid HTTP transport that lacks health.
      if (config.nexusTransport.health === undefined) {
        throw new Error(
          "HTTP nexus transport is missing required `health()` method. " +
          "Production HTTP transports must satisfy HealthCapableNexusTransport. " +
          "If using a custom transport adapter, add a health() implementation or " +
          "wrap with createHttpTransport from @koi/nexus-client.",
        );
      }
      probeTransport = config.nexusTransport as HealthCapableNexusTransport;
    } else if (config.nexusProbeFactory !== undefined) {
      probeTransport = config.nexusProbeFactory();
    } else if (config.nexusPermissionsEnabled === true || config.nexusAuditEnabled === true) {
      // Local-bridge with consumers enabled but no probe factory = unvalidated
      // boot on the highest-risk transport. Refuse to start. This closes the
      // observability hole where startup reports success while performing
      // zero Nexus validation; first real RPC discovers wedge/transport
      // failures only when downstream callers issue them.
      throw new Error(
        "Nexus consumers (permissions or audit) are enabled on a local-bridge " +
        "transport but nexusProbeFactory is not provided. Local-bridge cannot " +
        "be probed in place safely (auth-wedge risk on the long-lived session). " +
        "Pass nexusProbeFactory to construct a disposable probe subprocess, or " +
        "switch to HTTP transport, or disable Nexus consumers " +
        "(nexusPermissionsEnabled=false AND nexusAuditEnabled=false).",
      );
    } else {
      // No consumers wired and no probe factory → there's nothing to validate.
      // Skip silently (this is a no-op Nexus configuration).
      logger.debug({ kind: "local-bridge" },
        "nexus probe skipped: no consumers enabled and no probe factory provided");
    }

    let health;
    if (probeTransport !== undefined) {
      try {
        health = await probeTransport.health({
          readPaths: [`${policyBase}/version.json`, `${policyBase}/policy.json`],
        });
      } finally {
        if (probeTransport !== config.nexusTransport) probeTransport.close();
      }
    }

    // Step 2: branch on probe result + boot mode.
    // KEY INVARIANT: telemetry mode is ADVISORY ONLY — probe failures are logged
    // but do NOT suppress consumer wiring. Existing local-first / polling
    // recovery semantics handle transient outages.
    if (health !== undefined && !health.ok) {
      const msg = `Nexus transport unhealthy: ${health.error.message} (code=${health.error.code})`;
      if (mode === "telemetry") {
        logger.warn({ err: health.error, probeKind: config.nexusTransport.kind }, msg);
      } else {
        throw new Error(msg, { cause: health.error });  // fail-closed-* throws
      }
    } else if (health !== undefined) {
      // Distinct success log per probe target — operators must not mistake
      // disposable-probe success for live-session validation on local-bridge.
      const probeScope = config.nexusTransport.kind === "local-bridge"
        ? "spawn-config-validated (disposable probe; live session NOT validated)"
        : "session-validated";
      logger.info({
        latencyMs: health.value.latencyMs,
        version: health.value.version,
        probed: health.value.probed,
        probeScope,
      }, `nexus probe ok: ${probeScope}`);
    }
    // health === undefined → probe skipped (already logged above)
  }

  // Step 3: wire nexus consumers — wiring is gated ONLY by whether nexusTransport
  // was configured, NOT by probe outcome. Telemetry probe is advisory.
  //
  // CRITICAL local-bridge caveat: createNexusPermissionBackend's initializePolicy()
  // immediately issues read("version.json") + read("policy.json") on the supplied
  // transport. For HTTP this is fine. For local-bridge, an auth_required during
  // this first sync wedges the serialized session — the SAME class of failure the
  // probe was designed to avoid. Since backend.ready resolves only after first sync,
  // and we do NOT pass nonInteractive on consumer-driven calls (real work needs
  // auth), this is unavoidable in default telemetry mode without bridge-protocol
  // changes.
  //
  // Mitigation in this PR:
  //   - Document the risk in package README + log a warning when local-bridge
  //     transport is wired ("first sync may stall behind auth challenge")
  //   - createNexusPermissionBackend gains a new option `deferInitialSync?: boolean`
  //     (default false to preserve existing behavior). When true, initializePolicy()
  //     runs lazily — first poll happens on the regular sync interval rather than
  //     immediately at construction. Runtime sets this true for local-bridge in
  //     telemetry mode so first sync overlaps with normal user activity rather than
  //     blocking boot. Sync still happens, just not in the boot-critical path.
  //   - **`ready` semantics PRESERVED**: it still resolves only after first sync
  //     completes (or falls back). When `deferInitialSync: true`, `ready` is
  //     pending until the first scheduled sync finishes — runtime startup does
  //     NOT await `ready` in telemetry mode (matches existing behavior — only
  //     fail-closed-remote-policy-loaded awaits it). A new `awaitFirstSync()`
  //     method is the explicit signal for "first sync done"; `ready` stays
  //     unchanged so existing callers don't get false positives.
  //   - Auth state established by user activity (submitAuthCode) unblocks the
  //     deferred sync naturally
  //   - **Immediate post-auth trigger (this PR):** when the local-bridge
  //     transport emits its first auth-success signal (existing
  //     `submitAuthCode` resolution path), the runtime invokes
  //     `nexusPermBackend.triggerImmediateSync()` rather than waiting for the
  //     next timer tick. This collapses the local-fallback window from
  //     `nexusSyncIntervalMs` (default 30s) down to "first auth → first sync"
  //     (typically <1s). Permission checks issued before that trigger still
  //     fall back to local TUI rules — that is the explicit telemetry-mode
  //     contract — but the window is no longer a full poll interval.
  //     Operators wanting ZERO local-fallback window MUST use HTTP transport
  //     + fail-closed-remote-policy-loaded; local-bridge cannot achieve this
  //     without bridge-protocol changes.
  //
  // EXPLICIT TRUST-BOUNDARY ACKNOWLEDGMENT (telemetry mode contract):
  //   Telemetry mode is ADVISORY by design. Between boot and first successful
  //   sync, permission checks are answered by the LOCAL TUI fallback — Nexus
  //   policy is not yet loaded and is not consulted. This is the same window
  //   that exists today in v2 (pre-PR), and is the defined behavior of
  //   "telemetry mode" since the design's first review pass. `deferInitialSync`
  //   does NOT widen this window in any meaningful way: HTTP transport in
  //   telemetry mode also does not block boot on `ready`, so the first turn
  //   can begin before sync completes there too. Operators who require remote
  //   policy to be loaded before any work runs MUST select
  //   `fail-closed-remote-policy-loaded` (HTTP-only). On local-bridge,
  //   blocking-first-sync is structurally unsafe (auth wedge), so the only
  //   supported strict mode for local-bridge is "do not use it for compliance
  //   workloads" — the runtime preflight rejects local-bridge + fail-closed-*
  //   precisely because of this gap.
  // Nexus permissions are EXPLICIT and INDEPENDENT of Nexus audit. The runtime
  // refuses to boot with `nexusTransport` set + `nexusPermissionsEnabled`
  // unset — operators must declare intent to avoid silent enablement or
  // silent downgrade. Existing v2 deployments that wired Nexus permissions
  // implicitly via `nexusTransport` set `nexusPermissionsEnabled: true` on
  // upgrade (one-line migration; the throw message names the field).
  if (config.nexusTransport !== undefined && config.nexusPermissionsEnabled === undefined) {
    throw new Error(
      "nexusTransport is configured but nexusPermissionsEnabled is unset. " +
      "Set true to wire createNexusPermissionBackend (existing v2 behavior), " +
      "or false for audit-only deployments. Explicit declaration is required " +
      "to prevent silent permission-policy changes on upgrade.",
    );
  }
  let nexusPermBackend;
  if (config.nexusTransport !== undefined && config.nexusPermissionsEnabled === true) {
    // HARD GATE: local-bridge + Nexus permissions is rejected by default.
    // The first policy sync issues read(version.json) + read(policy.json) on
    // the shared subprocess. If auth is not yet established, the call hits
    // `auth_required` and wedges the serialized session — taking permission
    // sync AND consumer calls down. There is no in-band cancel/reset on the
    // bridge protocol today. Operators who accept this risk MUST set
    // `nexusPermissionsOnLocalBridgeAck: true` (e.g., for dev/test where the
    // user authenticates before any boot work runs).
    if (
      config.nexusTransport.kind === "local-bridge" &&
      config.nexusPermissionsOnLocalBridgeAck !== true
    ) {
      throw new Error(
        "Nexus permissions on local-bridge transport is unsupported by default: " +
        "first policy sync can wedge the shared subprocess on auth_required. " +
        "Use HTTP transport, OR set nexusPermissionsOnLocalBridgeAck=true to " +
        "acknowledge the wedge risk (dev/test only — not for production).",
      );
    }
    const deferInitialSync = config.nexusTransport.kind === "local-bridge"
      && (config.nexusBootMode ?? "telemetry") === "telemetry";
    // Validation: deferInitialSync requires a positive sync interval. With
    // syncIntervalMs === 0 (polling disabled), deferring the constructor sync
    // means first sync NEVER runs — `ready` would stay pending forever and
    // `isCentralizedPolicyActive()` would stay false. Throw early at config
    // time with an actionable message rather than producing a silent deadlock.
    if (deferInitialSync && (config.nexusSyncIntervalMs ?? 30_000) === 0) {
      throw new Error(
        "Invalid Nexus config: local-bridge + telemetry mode defers initial sync " +
        "to the regular timer, but nexusSyncIntervalMs=0 disables polling. " +
        "Set nexusSyncIntervalMs > 0, or use HTTP transport, or switch to a fail-closed mode.",
      );
    }
    nexusPermBackend = createNexusPermissionBackend({
      transport: config.nexusTransport,
      policyPath: config.nexusPolicyPath ?? "koi/permissions",  // existing backend field name
      deferInitialSync,  // NEW backend option (see file list)
      syncIntervalMs: config.nexusSyncIntervalMs,
      // … existing config …
    });

    // Step 4: policy-load check — ONLY in fail-closed-remote-policy-loaded mode.
    // CONTRACT: this gates that remote policy was LOADED at boot. It does NOT
    // gate that remote policy will be ENFORCED for every check — current
    // permission composition chains to local TUI on ask/no-opinion results
    // (runtime-factory.ts:1797-1806). Strict centralized enforcement requires
    // a separate permission-composition change tracked outside this PR.
    if ((config.nexusBootMode ?? "telemetry") === "fail-closed-remote-policy-loaded") {
      await nexusPermBackend.ready;
      if (!nexusPermBackend.isCentralizedPolicyActive()) {
        throw new Error(
          "Nexus remote policy not loaded after first sync (file missing, parse error, or backend rebuild failed); " +
          "fail-closed-remote-policy-loaded mode requires remote policy loaded at boot. " +
          "Note: this mode does NOT prevent local-rule fallback for queries not matched by remote policy.",
        );
      }
    }
    // telemetry / fail-closed-transport: do NOT await ready (preserves existing async semantics)
  }

  // Step 5: wire Nexus audit sink. Hook into shared `auditPoisonError`
  // accumulator (collapsed from ndjsonPoisonError + sqlitePoisonError as part
  // of this PR) ONLY when operator opts in. Best-effort default preserves
  // telemetry-mode behavior.
  //
  // LOCAL-BRIDGE AUDIT GATE: Nexus audit on local-bridge requires an explicit
  // mode declaration — silently dropping the sink is unsafe when Nexus is the
  // intended durable audit destination. Three legal configurations:
  //
  //   1. nexusAuditMode = "require"  → wire Nexus audit sink (operator has
  //      acknowledged the wedge risk; equivalent to old `Ack=true`).
  //   2. nexusAuditMode = "local-only" → SKIP Nexus audit sink AND assert at
  //      least one local sink (NDJSON or SQLite) is configured. Throw if no
  //      local sink exists, since 'local-only' with zero sinks = silent audit
  //      data loss.
  //   3. nexusAuditMode = "disabled" → SKIP Nexus audit sink with no fallback
  //      assertion. Operator has explicitly chosen no Nexus audit (e.g.,
  //      observability-only deployment with telemetry elsewhere).
  //
  // No default — the runtime throws if `nexusTransport.kind === "local-bridge"`
  // and `nexusAuditMode` is unset. This forces an explicit operator decision
  // rather than silently degrading. HTTP transport ignores this field and
  // always wires the sink (no wedge surface).
  if (config.nexusTransport !== undefined && config.nexusAuditEnabled === undefined) {
    throw new Error(
      "nexusTransport is configured but nexusAuditEnabled is unset. " +
      "Set true to wire createNexusAuditSink (existing v2 behavior) or false " +
      "to skip Nexus audit (local sinks continue). Explicit declaration " +
      "required to prevent silent audit-policy changes on upgrade.",
    );
  }
  if (config.nexusTransport !== undefined && config.nexusAuditEnabled === true) {
    const isLocalBridge = config.nexusTransport.kind === "local-bridge";
    // HARD REJECT: local-bridge + audit poison-on-error is unshippable —
    // a poisoned audit write wedges the shared subprocess, taking permissions
    // and other consumers down with it. No isolation mechanism in this PR.
    if (isLocalBridge && config.nexusAuditPoisonOnError === true) {
      throw new Error(
        "Invalid Nexus config: nexusAuditPoisonOnError=true is incompatible " +
        "with local-bridge transport. The first audit write can wedge the " +
        "shared subprocess on auth_required, taking permissions and consumer " +
        "calls down. Use HTTP transport for fail-stop audit, OR keep " +
        "nexusAuditPoisonOnError=false (best-effort) on local-bridge.",
      );
    }
    if (isLocalBridge && config.nexusAuditMode === undefined) {
      throw new Error(
        "Nexus audit on local-bridge requires explicit nexusAuditMode: " +
        '"require" (wire sink, accept wedge risk), "local-only" (skip sink, ' +
        "require NDJSON or SQLite sink), or \"disabled\" (skip sink, no fallback).",
      );
    }
    if (isLocalBridge && config.nexusAuditMode === "local-only") {
      const hasLocalSink = ndjsonSinkConfigured || sqliteSinkConfigured;
      if (!hasLocalSink) {
        throw new Error(
          'nexusAuditMode="local-only" requires at least one local audit sink ' +
          "(NDJSON or SQLite) to be configured; otherwise audit data is lost silently.",
        );
      }
    }
    const skipNexusSink = isLocalBridge && config.nexusAuditMode !== "require";
    if (skipNexusSink) {
      logger.info(
        { mode: config.nexusAuditMode },
        "nexus audit sink not wired on local-bridge per nexusAuditMode",
      );
    } else {
      const onError = config.nexusAuditPoisonOnError === true
        ? (err: unknown) => {
            if (auditPoisonError === undefined) auditPoisonError = err;  // share with NDJSON/SQLite
            logger.error({ err }, "nexus audit sink poisoned");
          }
        : (err: unknown) => logger.warn({ err }, "nexus audit write failed (best-effort)");
      auditSinks.push(createNexusAuditSink({ transport: config.nexusTransport, onError }));
    }
  } // end Nexus audit gate
  // … continue with non-nexus runtime construction …
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

`fail-closed-remote-policy-loaded` checks this **once at startup** after `await backend.ready` completes — i.e., it asserts that the first sync produced a remote backend. Post-boot transient failures do not re-trigger the gate. The new mode adds a startup guarantee without changing steady-state behavior.

**Explicit non-claim — naming is precise:** the mode is named `fail-closed-remote-policy-LOADED`, not `fail-closed-remote-policy-FRESH`. It guarantees that remote policy was loaded once at boot. It does NOT guarantee:

- That subsequent sync attempts succeed (network partition / Nexus down → node continues serving last-known-good remote policy indefinitely)
- That central-side policy changes (revocations, tightened denies) propagate within any bounded time
- That a withdrawn policy file (404 after first load) demotes the node — last-known-good is preserved by design (availability over consistency)

Operators requiring **freshness** (bounded staleness, demotion on revocation) need a separate mode (`fail-closed-remote-policy-fresh` with TTL/heartbeat semantics) — explicitly out of scope for this PR and tracked as a follow-up. Conflating freshness with load-at-boot in this PR would invite operator surprise; calling them different modes preserves option-space for the freshness work without misrepresenting today's guarantee.

Runtime config validation MAY warn (not throw) if `fail-closed-remote-policy-loaded` is selected without any out-of-band freshness mechanism (e.g., short `nexusSyncIntervalMs` + alerting on backend.lastSyncError) so operators don't conflate the two guarantees.

**Type-system enforcement:** the runtime config field is typed as base `NexusTransport` (since long-lived local-bridge transports do not expose `health`). HTTP transports happen to also satisfy `HealthCapableNexusTransport` and are upcast at the probe site. The `as unknown as NexusTransport` cast in `tui-command.ts:1704` is dropped — fs-nexus local-bridge structurally satisfies `NexusTransport` directly once the `kind` discriminator is added. `assertHealthCapable` is exported for callers who hold a base `NexusTransport` and need to narrow before invoking `health()` themselves (e.g., custom probe wrappers); it is NOT used in the standard tui-command path.

**Why this is the right policy:**

- Default mode preserves the existing local-first contract — no regression
- Operators get visibility into Nexus health via logs at every startup
- Compliance/security deployments opt in to `fail-closed-transport` or `fail-closed-remote-policy-loaded` explicitly
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
| `packages/lib/fs-nexus/src/local-transport.ts` | (1) Per-call `opts.deadlineMs` for use by the disposable probe. (2) Per-call `opts.nonInteractive` — on `auth_required`: reject in-flight call and kill the subprocess (disposable-probe path only). (3) Add `kind: "local-bridge"` discriminator. **Does NOT implement `health()`** — long-lived local-bridge transport stays at base `NexusTransport`. Probing the live session is unsafe (auth wedge); `health()` only exists on the disposable probe variant. | +60 |
| `packages/lib/fs-nexus/src/transport.ts` | **Forward `health` from the wrapped HTTP transport** (currently this fs-nexus HTTP wrapper drops it, returning only `{ call, close, subscribe, submitAuthCode }`). Add `health` passthrough so the type contract upgrade in runtime-factory works for HTTP path. Add `kind: "http"` discriminator. | +20 |
| `packages/lib/fs-nexus/src/transport.test.ts` | New: HTTP wrapper forwards `health()` calls to underlying transport; result shape preserved; opts pass through | +50 |
| `packages/lib/fs-nexus/src/probe-transport.ts` | New: `createLocalBridgeProbeTransport(spawnConfig): HealthCapableNexusTransport` — spawns a fresh, short-lived bridge subprocess; the ONLY local-bridge variant that implements `health()`; closes itself after the call. spawnConfig is held in closure scope, never on the returned transport object (no credential leak). | +75 |
| `packages/lib/fs-nexus/src/probe-transport.test.ts` | New: probe spawns isolated subprocess; health() returns ok when bridge healthy; health() returns error when bridge auth-blocked (nonInteractive); probe subprocess is killed after probe regardless of result; probe failure does NOT affect any concurrently-running session transport | +110 |
| `packages/lib/fs-nexus/src/local-transport.test.ts` | New: per-call deadline rejects before transport default; long-lived session transport does NOT receive nonInteractive flag from runtime probe path; existing call/subscribe behavior unchanged | +80 |
| `packages/security/permissions-nexus/src/nexus-permission-backend.ts` | (1) Add `isCentralizedPolicyActive(): boolean` — read-only query of currently-serving backend (true iff serving remote, regardless of latest sync outcome); preserves existing skip-bad-update behavior. (2) Add `deferInitialSync?: boolean` config option (default false). When true, `initializePolicy()` is NOT called from the constructor; first sync runs on the regular timer instead. **`ready` semantics UNCHANGED** — still resolves only after first sync completes (or falls back); existing callers awaiting `ready` continue to get the original "first sync done" guarantee. Required by local-bridge telemetry path to avoid auth-wedge during boot. Existing HTTP / fail-closed-remote-policy-loaded paths leave it false. (3) Add `triggerImmediateSync(): Promise<void>` with explicit single-flight + version-ordering contract:

- **Single-flight:** at most ONE sync runs at a time. If a timer-driven sync is already in progress when `triggerImmediateSync()` is called, the call returns the SAME pending Promise (coalesced). If a triggered sync is in progress and the timer fires, the timer skips this tick. Implementation: a single `inFlight: Promise<void> | undefined` field guards both entrypoints.
- **Last-writer-loses on stale versions:** every successful sync read produces a `(versionFromVersionJson, fetchTimestampMs)` pair. Activation path compares against currently-active backend metadata and SKIPS commit if `versionFromVersionJson` is older than active OR equal-version-but-older-fetchTimestamp. Prevents an unlucky-timing trigger from rolling back the activated policy.
- **`ready` resolution rule:** `ready` resolves on the FIRST successful activation regardless of which entrypoint produced it. Subsequent syncs (timer or triggered) do not re-resolve.
- **Failure isolation:** a triggered-sync failure does NOT poison the timer; the timer continues on its regular cadence. A timer-sync failure does NOT block a subsequent trigger (operator-driven retry path).

Used by runtime-factory to collapse the local-fallback window after first auth-success on local-bridge. | +50 |
| `packages/security/permissions-nexus/src/nexus-permission-backend.test.ts` | New tests: false before any sync; false when first sync fails (404/parse/rebuild mismatch — no last-known-good); true after first successful sync; stays true when subsequent sync fails (last-known-good preserved); stays true when subsequent sync produces incompatible policy (skipped, last-known-good preserved); **`deferInitialSync: true` skips constructor sync; `ready` is PENDING until first scheduled sync completes (semantics preserved — does NOT resolve immediately, that would be a stale-state hazard); first sync happens on timer; `isCentralizedPolicyActive()` is false until first scheduled sync completes; existing callers awaiting `ready` continue to get the first-sync-done guarantee they had before** | +130 |
| `packages/meta/cli/src/runtime-factory.ts` | Type `nexusTransport` as base `NexusTransport` (long-lived session has no health); add `nexusBootMode`, `nexusPolicyPath`, `nexusAuditPoisonOnError`, `nexusPermissionsEnabled`, `nexusAuditEnabled`, `nexusAuditMode`, `nexusPermissionsOnLocalBridgeAck`, `nexusSyncIntervalMs`, `nexusProbeFactory` config fields; throw at config-validation when `nexusTransport` set and either `nexusPermissionsEnabled` or `nexusAuditEnabled` unset (forces explicit migration); throw on local-bridge + consumers-enabled + missing `nexusProbeFactory` (refuses unvalidated boot on highest-risk transport); preflight: throw on local-bridge + fail-closed-* (unsupported); local-bridge + telemetry without factory SKIPS probe (backward compat); probe via factory for local-bridge, in-place for HTTP; thread `nexusPolicyPath` into BOTH `health()` readPaths AND `createNexusPermissionBackend`; telemetry mode: log probe failure but always wire consumers; fail-closed-* throws on probe failure; in `fail-closed-remote-policy-loaded`, await `nexusPermBackend.ready` and check `isCentralizedPolicyActive()`; **collapse the two existing accumulators (`ndjsonPoisonError` AND `sqlitePoisonError`) into a single shared `auditPoisonError`** — both NDJSON and SQLite sink `onError` callbacks write to the unified accumulator; admission boundaries check the single field; **add early-throw validation** when `local-bridge + telemetry + nexusSyncIntervalMs===0` (deferred sync would never fire, deadlocking `ready`); route Nexus sink errors into it ONLY when `nexusAuditPoisonOnError === true` (default best-effort); existing middleware admission guards now cover Nexus too via shared accumulator; **wire Nexus compliance-recorder `onError` to `process.exit(1)` in opt-in mode (matches NDJSON/SQLite at `runtime-factory.ts:3058-3059`); best-effort logging in default mode (was silent — bug fix)** | +145 |
| `packages/security/audit-sink-nexus/src/config.ts` | **Add `onError?: (err: unknown) => void` to `NexusAuditSinkConfig`** — the field doesn't exist today; wrapper depends on it | +8 |
| `packages/security/audit-sink-nexus/src/nexus-sink.ts` | Remove silent `.catch(() => {})` on `startFlush()`; invoke `config.onError?.(err)` on flush failure (interval-triggered AND size-triggered AND explicit-flush-triggered paths must all route through `onError`) | +12 |
| `packages/security/audit-sink-nexus/src/nexus-sink.test.ts` | New: interval-triggered flush failure invokes `onError`; size-triggered flush failure invokes `onError`; explicit `flush()` failure invokes `onError`; `onError` undefined doesn't crash (regression guard against silent swallowing) | +60 |
| `packages/meta/cli/src/__tests__/runtime-factory-nexus-audit-poison.test.ts` | New tests: default (`nexusAuditPoisonOnError` unset) — Nexus middleware errors stay out of shared accumulator; admission boundaries do NOT block; best-effort preserved. Opt-in (`true`) — Nexus middleware error latches shared `auditPoisonError`; admission boundaries refuse work. **Compliance-recorder coverage (both modes):** default — failure logs warning (was silent regression); opt-in — failure invokes `process.exit(1)` callback (mocked in test). Matches NDJSON/SQLite test parity for both paths | +200 |
| `packages/meta/cli/src/__tests__/runtime-factory-health.test.ts` | New tests covering all three modes + activation race coverage (see Tests section) | +200 |
| `packages/meta/cli/src/tui-command.ts` | Drop the `as unknown as NexusTransport` cast at line 1704 — fs-nexus local-bridge transport now structurally satisfies base `NexusTransport` directly (after fs-nexus adds `kind: "local-bridge"` discriminator). Pass through as base `NexusTransport`; do NOT wrap with `assertHealthCapable` (long-lived local-bridge has no health by design — see fs-nexus/local-transport.ts row above). When the runtime later calls `nexusProbeFactory()`, the factory constructs a fresh probe with its own captured spawn config. | +8 |
| `docs/L2/nexus-client.md` | Document readiness probe semantics; `HealthCapableNexusTransport` contract; WS/gRPC/pool out-of-scope rationale | +60 |

**Total: ~1075 LOC (335 src + 680 test + 60 doc).**

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

7b. `telemetry mode + probe failure: STILL wires nexus permissions and audit consumers (advisory only — preserves local-first/polling recovery)`
7c. `telemetry mode + probe failure: subsequent successful sync activates remote policy normally (no permanent downgrade)`
7c2. `telemetry mode + probe failure: long-lived session transport remains usable` (probe used disposable, not session)
7d. `runtime-factory threads nexusPolicyPath into BOTH health() readPaths AND createNexusPermissionBackend` (mismatch is impossible)
7e. `default nexusPolicyPath is "koi/permissions" when config field omitted`
7f. `local-bridge + telemetry mode: probe spawns disposable subprocess (session not touched)`
7g. `local-bridge + fail-closed-transport mode: throws config validation error (unsupported)`
7h. `local-bridge + fail-closed-remote-policy-loaded mode: throws config validation error (unsupported)`
7g2. `local-bridge + telemetry mode WITHOUT nexusProbeFactory + permissions or audit enabled: throws config error` (refuses unvalidated boot on highest-risk transport)
7g2b. `local-bridge WITHOUT nexusProbeFactory + permissions=false + audit=false: probe skipped silently (no-op config — nothing to validate)`
7g3. `local-bridge + telemetry mode WITH nexusProbeFactory: probe runs via factory; success logs probeScope=spawn-config-validated`
7g4. `HTTP transport probe success logs probeScope=session-validated; local-bridge probe success NEVER logs session-validated`
7g5. `long-lived local-bridge transport object does NOT have a health method` (regression guard against unsafe in-place probing)
7g6. `local-bridge + telemetry: createNexusPermissionBackend is wired with deferInitialSync=true` (boot does not block on first sync that could trigger auth wedge)
7g7. `local-bridge + fail-closed-remote-policy-loaded: deferInitialSync=false` (we accept first-sync risk because operator chose strict mode)
7g8. `HTTP transport: deferInitialSync=false in all modes` (HTTP has no auth wedge risk)
7g10. `local-bridge + telemetry + nexusSyncIntervalMs=0: throws config validation error at boot` (deferred sync would never fire — actionable message, not deadlock)
7g11. `NDJSON sink failure latches shared auditPoisonError; SQLite admission boundary refuses next call` (proves accumulator unification — pre-PR, this would only block NDJSON path)
7g12. `SQLite sink failure latches shared auditPoisonError; NDJSON admission boundary refuses next call` (same, reverse direction)
7g13. `local-bridge + nexusAuditPoisonOnError=true: runtime logs warning at boot about audit-wedge limitation` (operator gets explicit signal)
7g14. `local-bridge WITHOUT nexusAuditMode: throws config error at boot` (forces explicit operator decision; no silent degradation)
7g15. `local-bridge + nexusAuditMode="require": Nexus audit sink wired; operator has explicitly accepted wedge risk`
7g16. `local-bridge + nexusAuditMode="local-only" + NDJSON sink configured: Nexus sink skipped; boot succeeds`
7g16b. `local-bridge + nexusAuditMode="local-only" + NO local sinks: throws config error (prevents silent audit data loss)`
7g16c. `local-bridge + nexusAuditMode="disabled": Nexus sink skipped; no fallback assertion; boot succeeds`
7g16d. `HTTP transport: nexusAuditMode ignored; sink always wired`
7g16e. `local-bridge WITHOUT nexusPermissionsOnLocalBridgeAck: throws config error at boot` (Nexus permissions on local-bridge requires explicit ack)
7g16f. `local-bridge WITH nexusPermissionsOnLocalBridgeAck=true: createNexusPermissionBackend wired; operator accepts wedge risk`
7g16g. `HTTP transport: nexusPermissionsOnLocalBridgeAck has no effect`
7g16h. `nexusTransport set + nexusPermissionsEnabled UNSET: throws config error with actionable migration message` (no silent enable, no silent downgrade — explicit operator decision required)
7g16i. `nexusPermissionsEnabled=false explicitly: permissions skipped; audit-only deployment boots`
7g16j. `nexusPermissionsEnabled=true + HTTP: permissions wired normally`
7g16j2. `nexusTransport set + nexusAuditEnabled UNSET: throws config error with actionable migration message` (mirror of permissions gate)
7g16j3. `nexusAuditEnabled=false: Nexus audit sink skipped regardless of nexusAuditMode value`
7g16j4. `nexusAuditEnabled=true + HTTP: nexusAuditMode ignored; sink wired (HTTP has no wedge surface)`
7g16j5. `local-bridge + nexusAuditEnabled=false: nexusAuditMode is NOT required (existing local-bridge boots that don't use Nexus audit are NOT broken)` (regression guard — backward-compat scoping)
7g16k. `local-bridge + nexusPermissionsEnabled=true + nexusAuditMode="local-only": both gates apply independently — permissions ack required, audit local-only enforced`
7g16l. `local-bridge + nexusPermissionsEnabled=true + telemetry: runtime subscribes to first-auth-success event and calls triggerImmediateSync() on resolution` (collapses local-fallback window from poll-interval to ~ms)
7g16m. `triggerImmediateSync() success: ready resolves; isCentralizedPolicyActive() flips true; subsequent permission checks consult remote policy`
7g16n. `triggerImmediateSync() failure: behavior matches a failed timer-driven sync (skipped, last-known-good preserved); local fallback continues`
7g16o. `local-bridge + nexusAuditPoisonOnError=true: throws config error at boot` (hard-rejected combination — message names HTTP migration path)
7g16p. `triggerImmediateSync() called while timer-sync in flight: returns SAME pending Promise (single-flight coalescing — no double-sync)`
7g16q. `timer fires while triggerImmediateSync() in flight: timer tick is SKIPPED (single-flight enforced from both entrypoints)`
7g16r. `concurrent trigger + timer race: only ONE network call observed; both await the same Promise; ready resolves exactly once`
7g16s. `stale-version protection: trigger fetches version=N then timer fetches version=N+1 first → trigger commit is SKIPPED, active backend has N+1` (last-writer-loses on stale; activation order matches version order)
7g16t. `triggered-sync failure does NOT cancel or delay next timer tick (failure isolation)`
7g17. `fail-closed-remote-policy-loaded: post-boot 404 on policy file does NOT demote node — last-known-good preserved; isCentralizedPolicyActive stays true; no second gate trigger` (regression guard for naming claim — "loaded" not "fresh")
7g18. `telemetry mode + deferInitialSync: explicit advisory contract documented in startup log — "permission checks served by local fallback until first sync completes"` (operator visibility for the trust-boundary acknowledgment)
7g9. `HTTP transport without health() method: throws actionable error (not raw TypeError)`
7h2. `transport object does NOT expose spawn config / credentials` (security regression guard)
7i. `HTTP transport: always probes session directly regardless of mode (no auth flow risk)`
7j. `fs-nexus HTTP wrapper forwards health() to underlying transport (regression guard)`
8. `telemetry default: succeeds and logs warning on health() error` — local-first preserved
9. `telemetry: succeeds and logs info on transport ok`
10. `telemetry: does NOT await backend.ready` — preserves existing async semantics
11. `fail-closed-transport: throws on transport error`
12. `fail-closed-transport: does NOT await backend.ready` — only transport gate, no policy gate
13. `fail-closed-remote-policy-loaded: awaits backend.ready before exposing runtime`
14. `fail-closed-remote-policy-loaded: throws when first sync fails (no last-known-good) — file 404, no remote backend ever activated`
15. `fail-closed-remote-policy-loaded: throws when first sync fails — parse error`
16. `fail-closed-remote-policy-loaded: throws when first sync fails — rebuild shape mismatch`
17. `fail-closed-remote-policy-loaded: succeeds when first sync succeeds (isCentralizedPolicyActive === true)`
17b. `fail-closed-remote-policy-loaded: post-boot transient failure does NOT re-trigger gate — last-known-good remote policy preserved` (regression guard for availability)
18. `fail-closed-remote-policy-loaded: NO permission check executes against local backend before policy ready` — race coverage
19. `default mode is "telemetry" regardless of audit wiring` (honest contract)
20. `explicit nexusBootMode override always wins`
21. `skips preflight when nexusTransport is undefined`
22. `fail-closed-transport / fail-closed-remote-policy-loaded error messages include nexus error code`
23. `existing local-first golden test still passes (telemetry default)` — regression guard

`packages/lib/fs-nexus/src/local-transport.test.ts` (additions):

16. **NEGATIVE: long-lived local-bridge transport object does NOT have a `health` method** (regression guard against the spec contradiction caught in review — health belongs ONLY on the disposable probe variant)

`packages/lib/fs-nexus/src/probe-transport.test.ts` (additions — moved from local-transport):

20. `probe health() returns ok when freshly-spawned subprocess responds to version + reads`
21. `probe health() returns error when subprocess has exited before probe`
22. `probe health() returns error when stdio handshake fails before probes complete`
23. `probe subprocess is killed after health() regardless of result`

Existing `transport.test.ts` continues to pass unchanged.

## Migration (existing v2 deployments)

Existing v2 callers that pass `nexusTransport` already get Nexus permissions and audit wired implicitly. This PR makes both consumers explicit. On upgrade:

| Existing behavior | Required new config |
|---|---|
| `nexusTransport` set (Nexus permissions + audit both wired implicitly) | `nexusPermissionsEnabled: true, nexusAuditEnabled: true` |
| `nexusTransport` + local-bridge with implicit audit | Add `nexusAuditMode: "require"` (preserves wiring) AND `nexusPermissionsOnLocalBridgeAck: true` if permissions also wanted |
| `nexusTransport` + HTTP | Just add `nexusPermissionsEnabled` and `nexusAuditEnabled` (no other gates apply) |

The runtime throws with an actionable error message naming the missing field if any of these are unset — there is no silent-degradation path. Migration is one config object change per deployment.

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
- [ ] `local-transport.test.ts` proves long-lived transport has NO `health` method (negative test)
- [ ] New `probe-transport.test.ts` health cases pass (probe-only)
- [ ] **New `runtime-factory-health.test.ts` proves both boot modes:**
  - telemetry default succeeds + logs on health failure (local-first preserved)
  - fail-closed opt-in throws on health failure
  - existing local-first golden test still passes (regression guard)
- [ ] `bun run typecheck`, `bun run lint`, `bun run check:layers` clean
- [ ] PR description explains punted scope (gRPC/WS/pool) with rationale
- [ ] Issue #1401 closed by PR
