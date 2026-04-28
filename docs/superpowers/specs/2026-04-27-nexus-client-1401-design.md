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
// `kind` is OPTIONAL on the public base interface (preserves source-compat
// for test-only structural mocks). At the PRODUCTION runtime boundary
// (createKoiRuntime), `assertProductionTransport(t)` THROWS if `kind` is
// undefined — production callers MUST construct via one of the named
// factories (createHttpTransport, createLocalBridgeTransport, fs-nexus
// HTTP wrapper, createLocalBridgeProbeTransport) which always set it.
// Failing closed on missing `kind` prevents a stale adapter from being
// silently mis-classified as HTTP and routed down the in-place probe path.
// `getTransportKind(t)` is RETIRED — use `assertProductionTransport(t).kind`
// instead so runtime branches are guaranteed to hold a discriminated value.

/** Base transport — minimal surface, satisfied by tests/mocks/fixtures. */
export interface NexusTransport {
  readonly kind?: NexusTransportKind | undefined;  // optional on base for test-only mocks; assertProductionTransport(t) THROWS at the production runtime boundary if undefined — never defaults
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
   - **local-bridge + `telemetry`:** probe via a disposable subprocess **when caller provides `nexusProbeFactory`** (observability-only — no Nexus consumer is wired on local-bridge, so the probe never gates boot). If absent, the probe is silently skipped. Single rule: probe-factory always optional on local-bridge. The transport object never exposes spawn config or credentials; the factory remains a sealed capability so when supplied, spawn config doesn't leak through the long-lived transport object.
   - **local-bridge + `fail-closed-transport` / `assert-remote-policy-loaded-at-boot`:** **NOT SUPPORTED.** Throws a config validation error at startup. Both implementation options would produce wrong behavior (session-wedge or false-guarantee). Once the bridge gains a non-poisoning cancel/reset (out of scope), this restriction can be lifted. Operators needing fail-closed must use HTTP transport.

   API surface:
   - `createLocalBridgeTransport(config)` → long-lived session transport (no probe support exposed)
   - `createLocalBridgeProbeTransport(spawnConfig)` → disposable transport that closes after one `health()` call. Caller passes spawn config; transport object does NOT retain it after spawn.
   - `KoiRuntimeFactoryConfig.nexusProbeFactory?: () => HealthCapableNexusTransport` — caller-supplied factory for probe construction. Always optional. On local-bridge no Nexus consumer is wired (permissions rejected, audit always skips Nexus sink), so the probe is observability-only when supplied. Not stored on the runtime; called once during boot then discarded.

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

## Startup integration (telemetry by default, opt-in fail-closed-transport / assert-remote-policy-loaded-at-boot)

The real production boundary is `packages/meta/cli/src/runtime-factory.ts:832` (`KoiRuntimeFactoryConfig.nexusTransport`). The runtime factory wires Nexus into `createNexusPermissionBackend` and `createNexusAuditSink`.

**Critical existing contract: local-first permissions.** `createNexusPermissionBackend` is documented as "local-first: TUI rules apply when Nexus has no policy or is unreachable." A golden test in `meta/runtime/src/__tests__/golden-replay.test.ts` proves this fallback. **A fail-closed startup gate would break this contract** and convert recoverable Nexus outages into total runtime unavailability. That is a regression.

**Decision: telemetry-by-default for everything; fail-closed-transport and assert-remote-policy-loaded-at-boot are explicit opt-ins.**

Earlier drafts proposed making audit-wired runtimes default to `fail-closed-transport`. That was wrong: `health()` does NOT probe the audit write path (no non-side-effecting audit RPC exists today), so defaulting to fail-closed for audit gives a **false safety signal**. Better to be honest: telemetry default for everything, document the audit-write gap, and let operators opt in.

| Mode | Behavior |
|---|---|
| `telemetry` (default) | log on transport failure; log activation status; continue boot |
| `fail-closed-transport` | throw on transport failure for any of the 3 probes (version + version.json read + policy.json read); does NOT validate that policy files exist or that backend successfully activates remote policy |
| `assert-remote-policy-loaded-at-boot` | throw on transport failure; throw on first-sync policy-activation failure (awaits `backend.ready`). **STARTUP GATE ONLY, REMOTE-LOAD ONLY** — proves remote policy was loaded at boot. Does NOT prove remote policy will be enforced for every check: per existing composition (`runtime-factory.ts:1797-1806`), Nexus backend chains to local TUI on `ask`/no-opinion results, so queries not matched by remote policy still execute under local rules. Does NOT enforce ongoing freshness either: last-known-good remote policy continues to be served after sync failures. Operators needing strict centralized enforcement (no local fallback for unmatched queries) need a permission-composition change tracked separately. |

**⚠️ Security caveat — no mode in this PR provides centralized-policy enforcement.** `fail-closed-transport` only proves the transport can carry read calls. `assert-remote-policy-loaded-at-boot` only proves remote policy was loaded at boot. Neither prevents local-rule fallback for queries the remote policy doesn't match (existing permission composition chains to local TUI on `ask`/no-opinion). The mode names deliberately reflect what they actually gate (`-transport`, `-remote-policy-loaded`) rather than implying enforcement they don't deliver. **Operators requiring strict centralized enforcement (no local fallback for unmatched queries) must wait for the permission-composition change tracked separately** — neither mode here is sufficient for that requirement.

**Policy-activation check** (only in `assert-remote-policy-loaded-at-boot`):

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

When `nexusAuditPoisonOnError === true`, the runtime hooks Nexus sink errors into a **per-sink poison latch** that is checked independently at every admission boundary — exactly matching the existing pre-PR NDJSON/SQLite semantics. **Per-sink fail-stop is preserved**: if ANY required sink poisons, admission denies. This is NOT a quorum gate — operators who configured both NDJSON and SQLite as required intentionally want both durable trails or no work to proceed.

**Per-sink state, per-sink fail-stop admission (matches pre-PR behavior exactly):**

- Each sink gets its own poison latch (`ndjsonPoison`, `sqlitePoison`, `nexusPoison`).
- Each required sink's latch is checked at every admission boundary (`onSessionStart`, `onBeforeTurn`, `wrapModelCall`, `wrapToolCall`, end-of-session flush). ANY poisoned required latch denies admission. This is the existing semantics for NDJSON and SQLite — Nexus joins on the same terms when `nexusAuditPoisonOnError === true`.
- Optional sinks (e.g., NDJSON without the existing `required: true` config; Nexus with `nexusAuditPoisonOnError !== true`) log on failure but never block admission.

```ts
const ndjsonPoison: { err?: unknown } = {};
const sqlitePoison: { err?: unknown } = {};
const nexusPoison: { err?: unknown } = {};

const ndjsonSink = createNdjsonAuditSink({
  // … existing config …
  onError: (err) => { if (ndjsonPoison.err === undefined) ndjsonPoison.err = err; },
});
const sqliteSink = createSqliteAuditSink({
  // … existing config …
  onError: (err) => { if (sqlitePoison.err === undefined) sqlitePoison.err = err; },
});
if (config.nexusTransport !== undefined && txKind === "http" && auditEnabled === true) {
  const onError = config.nexusAuditPoisonOnError === true
    ? (err: unknown) => {
        if (nexusPoison.err === undefined) nexusPoison.err = err;
        logger.error({ err }, "nexus audit sink poisoned");
      }
    : (err: unknown) => logger.warn({ err }, "nexus audit write failed (best-effort)");
  auditSinks.push(createNexusAuditSink({ transport: config.nexusTransport, onError }));
}

// Admission boundary check — per-sink fail-stop (matches pre-PR exactly):
function admissionAllowed(): boolean {
  if (config.ndjsonRequired && ndjsonPoison.err !== undefined) return false;
  if (config.sqliteRequired && sqlitePoison.err !== undefined) return false;
  if (config.nexusAuditPoisonOnError === true && nexusPoison.err !== undefined) return false;
  return true;
}
```

The Nexus addition is **orthogonal**: pre-PR NDJSON/SQLite required-sink behavior is unchanged. `nexusAuditPoisonOnError === true` opts Nexus into the same per-sink fail-stop discipline; `false` (default) leaves Nexus best-effort with no admission impact.

This means:

- **No new wrapper module needed** — the existing runtime-level guard pattern is the right abstraction
- **No spec drift between sink kinds** — Nexus poisoning behaves exactly like NDJSON/SQLite poisoning at every admission boundary
- **Nexus best-effort mode is preserved** — when `nexusAuditPoisonOnError !== true`, Nexus errors stay out of the per-sink poison latch and never trigger admission denial

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
| `true` | per-sink poison latch + admission deny (joins NDJSON/SQLite per-sink fail-stop) | `process.exit(1)` (matches NDJSON/SQLite) |

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

type NexusBootMode = "telemetry" | "fail-closed-transport" | "assert-remote-policy-loaded-at-boot";

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
   * Whether to wire `createNexusAuditSink` (HTTP only — local-bridge always
   * skips per nexusAuditMode).
   *   - true  → wire on HTTP; on local-bridge, requires nexusAuditMode.
   *   - false → SKIP; local sinks unaffected.
   * **Phase 1 (this PR):** unset → INFER `true` if `nexusTransport` is set,
   *   plus deprecation warning. **Phase 2 (next release):** throws.
   */
  readonly nexusAuditEnabled?: boolean | undefined;
  /**
   * REQUIRED only when `nexusAuditEnabled === true && nexusTransport.kind === "local-bridge"`.
   * Forces explicit operator decision rather than silent degradation:
   *   - "local-only" → skip Nexus sink; runtime asserts at least one local
   *                    sink (NDJSON or SQLite) is configured, else throws.
   *   - "disabled"   → skip Nexus sink with no fallback assertion.
   * (Round 1 follow-up: "require" mode REMOVED — wiring Nexus audit on the
   *  shared local-bridge session can wedge the subprocess on first auth_required,
   *  taking other Nexus consumers down. Until the bridge gains an isolated/auth-safe
   *  audit transport, local-bridge cannot host the Nexus audit sink. HTTP transport
   *  is the supported path for Nexus audit.)
   */
  readonly nexusAuditMode?: "local-only" | "disabled" | undefined;
  /**
   * Whether to wire `createNexusPermissionBackend`.
   *   - true  → wire (existing v2 behavior).
   *   - false → SKIP Nexus permissions; checks served by local TUI rules.
   * **Phase 1 (this PR):** unset → INFER `true` if `nexusTransport` is set,
   *   AND emit a one-time deprecation warning. Preserves existing healthy
   *   deployments through the rollout.
   * **Phase 2 (next release):** unset → throw at config validation.
   */
  readonly nexusPermissionsEnabled?: boolean | undefined;
  // (REMOVED in Round 10: nexusPermissionsOnLocalBridgeAck. Local-bridge +
  // Nexus permissions is now categorically rejected — even with operator
  // ack, work issued before first sync would authorize against local-TUI
  // fallback. No escape hatch in this PR.)
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
   * - "assert-remote-policy-loaded-at-boot": throw on transport failure OR first-sync
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

  // Step 0: RESOLVE consumer flags BEFORE any gate fires. All subsequent
  // checks (probe-factory required, security gates, audit-mode required)
  // run against `permsEnabled`/`auditEnabled`/`txKind`, never the raw
  // optional config fields. This guarantees inferred-true cannot bypass
  // a gate that explicit-true would trip. See Phase 1/Phase 2 rules below.
  //
  // Phase 1 inference rules (this PR):
  //   - HTTP transport: unset perms/audit → infer TRUE + warn (preserves v2).
  //   - local-bridge transport: unset perms/audit → infer FALSE + warn.
  //     **Architectural decoupling required to avoid contradictory tradeoffs:**
  //     `tui-command.ts` STOPS passing `nexusTransport` into `createKoiRuntime`
  //     when no Nexus consumer is intentionally wanted. fs-only sessions use
  //     the local-bridge transport directly via the fs-nexus path; they do NOT
  //     thread it through the runtime's Nexus consumer block. With that
  //     change, the only callers reaching this inference branch are operators
  //     who DID intend to wire a Nexus consumer, and inferring FALSE is the
  //     correct post-PR posture (perms rejected; audit always skips Nexus
  //     sink). This resolves the round-6/round-7 oscillation: existing
  //     fs-only sessions don't break (decoupling) AND silent permission/audit
  //     downgrade can't happen (no caller hits this path implicitly).
  //   - Phase 2 (next release) makes ALL unset cases throw.
  const txKind = config.nexusTransport !== undefined
    ? assertProductionTransport(config.nexusTransport).kind
    : undefined;
  const permsEnabled = config.nexusPermissionsEnabled
    ?? (txKind === "http" ? true : txKind === "local-bridge" ? false : undefined);
  const auditEnabled = config.nexusAuditEnabled
    ?? (txKind === "http" ? true : txKind === "local-bridge" ? false : undefined);
  // EFFECTIVE consumer wiring: applies nexusAuditMode after the boolean.
  // local-bridge audit always skips the Nexus sink regardless of auditEnabled,
  // and nexusAuditMode="disabled" on any transport explicitly opts out.
  // Probe gating + boot-mode validation use these EFFECTIVE values so a
  // disabled-by-mode consumer doesn't trigger probe work.
  const effectiveAuditWired =
    auditEnabled === true
    && txKind === "http"
    && config.nexusAuditMode !== "disabled";
  const effectivePermsWired = permsEnabled === true && txKind === "http";
  const anyEffectiveConsumer = effectivePermsWired || effectiveAuditWired;
  if (config.nexusTransport !== undefined) {
    const inferredPerms = config.nexusPermissionsEnabled === undefined;
    const inferredAudit = config.nexusAuditEnabled === undefined;
    if (inferredPerms || inferredAudit) {
      const inferences: string[] = [];
      if (inferredPerms) inferences.push(`nexusPermissionsEnabled→${permsEnabled}`);
      if (inferredAudit) inferences.push(`nexusAuditEnabled→${auditEnabled}`);
      logger.warn({ inferences, txKind },
        "DEPRECATED: nexusTransport set with implicit consumer flags. " +
        `Set explicitly: ${inferences.join(", ")}. ` +
        (txKind === "local-bridge"
          ? "On local-bridge, inferred FALSE matches new security posture " +
            "(Nexus permissions rejected; audit always skips Nexus sink). " +
            "Existing v2 wiring of these consumers is being SKIPPED — set true " +
            "explicitly only if you understand the implications. "
          : "") +
        "Phase 2 (next release) will throw on unset.");
    }
  }
  // SECURITY GATE (Phase 1 + Phase 2): Nexus permissions on local-bridge
  // is categorically rejected. Local-bridge with unset flags throws above
  // (no-flags throw); this gate fires when the operator explicitly opts in
  // to the unsafe combination.
  if (txKind === "local-bridge" && permsEnabled === true) {
    throw new Error(
      "Nexus permissions on local-bridge transport is unsupported: " +
      "(a) first policy sync can wedge the shared subprocess on auth_required, " +
      "(b) requests issued before first sync authorize against local-TUI " +
      "fallback (centralized-policy bypass). Use HTTP transport.",
    );
  }

  // Probe + Nexus consumer wiring is GATED on resolved consumer flags.
  // A filesystem-only Nexus transport (both consumers explicitly false, OR
  // local-bridge no-flags inferred-false) skips ALL Nexus startup probing
  // and consumer wiring — the transport is used elsewhere (fs reads etc.)
  // and is none of this block's concern. Without this gate, `fail-closed-*`
  // could block boot for an opted-out configuration on an unrelated
  // permissions/audit readiness probe.
  if (config.nexusTransport !== undefined && anyEffectiveConsumer) {
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
    if (assertProductionTransport(config.nexusTransport).kind === "local-bridge" && mode !== "telemetry") {
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
    if (assertProductionTransport(config.nexusTransport).kind === "http") {
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
    } else {
      // local-bridge: probe-factory is OPTIONAL and ADVISORY. Wrap construction
      // in try/catch so a synchronous spawn error (missing binary, permission
      // denied, bad env) becomes a logged warning rather than a startup
      // outage — matches the documented advisory contract.
      if (config.nexusProbeFactory !== undefined) {
        try {
          probeTransport = config.nexusProbeFactory();
        } catch (err: unknown) {
          logger.warn({ err, kind: "local-bridge" },
            "nexus probe-factory threw during construction; probe SKIPPED " +
            "(telemetry mode is advisory — boot continues)");
        }
      } else {
        logger.debug({ kind: "local-bridge" },
          "nexus probe skipped: no factory provided (no Nexus consumer wired on local-bridge)");
      }
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
      const probeScope = assertProductionTransport(config.nexusTransport).kind === "local-bridge"
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

  // Step 3: wire nexus consumers. Wiring is gated by transport-kind:
  //   - HTTP: full Nexus permissions + audit support, all boot modes available.
  //   - local-bridge: permissions REJECTED categorically (early-request
  //     centralized-policy bypass — see hard-reject below). Audit gated by
  //     nexusAuditMode (Round 5+ contract).
  // Telemetry-mode HTTP probe failure is advisory — wiring still proceeds.
  let nexusPermBackend;
  if (config.nexusTransport !== undefined && permsEnabled === true) {
    // (REMOVED in Round 10: deferInitialSync + triggerImmediateSync mitigations.
    //  Their sole purpose was to soften the local-bridge auth-wedge during first
    //  policy sync; with local-bridge + permissions now categorically rejected,
    //  these mitigations are dead code. HTTP path uses immediate constructor-time
    //  sync exactly as before this PR.)
    nexusPermBackend = createNexusPermissionBackend({
      transport: config.nexusTransport,
      policyPath: config.nexusPolicyPath ?? "koi/permissions",  // existing backend field name
      syncIntervalMs: config.nexusSyncIntervalMs,
      // … existing config …
    });

    // Step 4: policy-load check — ONLY in assert-remote-policy-loaded-at-boot mode.
    // CONTRACT: this gates that remote policy was LOADED at boot. It does NOT
    // gate that remote policy will be ENFORCED for every check — current
    // permission composition chains to local TUI on ask/no-opinion results
    // (runtime-factory.ts:1797-1806). Strict centralized enforcement requires
    // a separate permission-composition change tracked outside this PR.
    if ((config.nexusBootMode ?? "telemetry") === "assert-remote-policy-loaded-at-boot") {
      await nexusPermBackend.ready;
      if (!nexusPermBackend.isCentralizedPolicyActive()) {
        throw new Error(
          "Nexus remote policy not loaded after first sync (file missing, parse error, or backend rebuild failed); " +
          "assert-remote-policy-loaded-at-boot mode requires remote policy loaded at boot. " +
          "Note: this mode does NOT prevent local-rule fallback for queries not matched by remote policy.",
        );
      }
    }
    // telemetry / fail-closed-transport: do NOT await ready (preserves existing async semantics)
  }

  // Step 5: wire Nexus audit sink. Routes failures into the per-sink
  // `nexusPoison` latch (joins NDJSON/SQLite per-sink fail-stop discipline) ONLY when operator opts in. Best-effort default preserves
  // telemetry-mode behavior.
  //
  // LOCAL-BRIDGE AUDIT GATE: wiring Nexus audit on local-bridge is
  // CATEGORICALLY UNSUPPORTED in this PR — the shared subprocess can be
  // wedged by a single failed audit write on auth_required, taking other
  // Nexus consumers down with it. Operator must declare one of two legal
  // configurations to acknowledge the constraint:
  //
  //   1. nexusAuditMode = "local-only" → SKIP Nexus sink AND assert at least
  //      one local sink (NDJSON or SQLite) exists, else throw.
  //   2. nexusAuditMode = "disabled"   → SKIP Nexus sink with no fallback
  //      assertion (e.g., observability-only deployment).
  //
  // The previous "require" mode is REMOVED. Operators wanting Nexus audit
  // MUST use HTTP transport (no shared-session surface).
  // (audit deprecation warning emitted in shared block above with permissions)
  if (config.nexusTransport !== undefined && auditEnabled === true) {
    const isLocalBridge = txKind === "local-bridge";
    // SECURITY GATE: local-bridge + nexusAuditPoisonOnError=true is unshippable
    // regardless of nexusAuditMode. Even when the Nexus sink is skipped, the
    // operator declared fail-stop semantics that local-bridge cannot honor
    // safely. Throw before any further audit gating runs.
    if (isLocalBridge && config.nexusAuditPoisonOnError === true) {
      throw new Error(
        "Invalid Nexus config: nexusAuditPoisonOnError=true is incompatible " +
        "with local-bridge transport. Use HTTP transport for fail-stop audit.",
      );
    }
    // HARD REJECT: local-bridge audit always skips the Nexus sink — operator
    // must declare which fallback policy applies (local-only or disabled).
    if (isLocalBridge && config.nexusAuditMode === undefined) {
      throw new Error(
        "Nexus audit on local-bridge is unsupported (shared session can be " +
        'wedged by a failed audit write). Set nexusAuditMode to "local-only" ' +
        '(skip Nexus sink + require NDJSON or SQLite sink) or "disabled" ' +
        "(skip Nexus sink with no fallback). Use HTTP transport for Nexus audit.",
      );
    }
    if (isLocalBridge && config.nexusAuditMode === "local-only") {
      const hasLocalSink = ndjsonSinkConfigured || sqliteSinkConfigured;
      if (!hasLocalSink) {
        throw new Error(
          'nexusAuditMode="local-only" requires at least one local audit sink ' +
          "(NDJSON or SQLite); otherwise audit data is lost silently.",
        );
      }
    }
    if (isLocalBridge) {
      // local-bridge always skips the Nexus sink (no "require" path)
      logger.info({ mode: config.nexusAuditMode },
        "nexus audit sink not wired on local-bridge per nexusAuditMode");
    } else {
      const onError = config.nexusAuditPoisonOnError === true
        ? (err: unknown) => {
            if (nexusPoison.err === undefined) nexusPoison.err = err;  // per-sink latch (quorum gate)
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

`assert-remote-policy-loaded-at-boot` checks this **once at startup** after `await backend.ready` completes — i.e., it asserts that the first sync produced a remote backend. Post-boot transient failures do not re-trigger the gate. The new mode adds a startup guarantee without changing steady-state behavior.

**Naming intentionally drops `fail-closed-` prefix (Round 7 follow-up):** the mode is named `assert-remote-policy-loaded-at-boot`, NOT `fail-closed-remote-policy-loaded`. The previous name invited operator confusion because the mode does NOT change permission composition — local TUI fallback still applies for queries unmatched by remote policy. Calling it "fail-closed-*" would oversell the security property. The new name describes exactly what it does: assert remote policy loaded successfully at boot, no more.

It does NOT guarantee:
- That subsequent sync attempts succeed (network partition / Nexus down → node continues serving last-known-good remote policy indefinitely)
- That central-side policy changes (revocations, tightened denies) propagate within any bounded time
- That a withdrawn policy file (404 after first load) demotes the node — last-known-good is preserved by design (availability over consistency)
- That **all queries are authorized by remote policy** — local TUI rules still answer queries the remote policy doesn't cover

Operators requiring true fail-closed semantics (no local fallback, freshness enforcement, demotion on revocation) need a different control plane — explicitly out of scope and tracked as follow-up work. The renamed mode preserves option-space for that future without misrepresenting today's guarantee.

Runtime config validation MAY warn (not throw) if `assert-remote-policy-loaded-at-boot` is selected without any out-of-band freshness mechanism (e.g., short `nexusSyncIntervalMs` + alerting on backend.lastSyncError) so operators don't conflate the two guarantees.

**Type-system enforcement:** the runtime config field is typed as base `NexusTransport` (since long-lived local-bridge transports do not expose `health`). HTTP transports happen to also satisfy `HealthCapableNexusTransport` and are upcast at the probe site. The `as unknown as NexusTransport` cast in `tui-command.ts:1704` is dropped — fs-nexus local-bridge structurally satisfies `NexusTransport` directly once the `kind` discriminator is added. `assertHealthCapable` is exported for callers who hold a base `NexusTransport` and need to narrow before invoking `health()` themselves (e.g., custom probe wrappers); it is NOT used in the standard tui-command path.

**Why this is the right policy:**

- Default mode preserves the existing local-first contract — no regression
- Operators get visibility into Nexus health via logs at every startup
- Compliance/security deployments opt in to `fail-closed-transport` or `assert-remote-policy-loaded-at-boot` explicitly
- The golden test for local-first fallback continues to pass unchanged

`assertHealthCapable<T extends NexusTransport>(t: T): asserts t is T & HealthCapableNexusTransport` is the assertion helper.

## Files

| File | Change | Est LOC |
|---|---|---|
| `packages/lib/nexus-client/src/types.ts` | Add `NexusCallOptions` (deadlineMs, nonInteractive), `NexusHealthOptions` (readPaths), `NexusHealth`, **optional** `kind?: NexusTransportKind` on `NexusTransport` (preserves source-compat for structural mocks), optional `health` on `NexusTransport`, required `health` on `HealthCapableNexusTransport`; extend `call` signature with optional `opts` (additive — existing call sites without opts still type-check); add `assertProductionTransport(t)` helper that THROWS when `t.kind` is undefined (fail-closed at production boundary; never default to "http" — would silently misroute stale adapters down in-place probe path) | +40 |
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
| `packages/security/permissions-nexus/src/nexus-permission-backend.ts` | Add `isCentralizedPolicyActive(): boolean` — read-only query of currently-serving backend (true iff serving remote, regardless of latest sync outcome); preserves existing skip-bad-update behavior. (Round 10 trim: `deferInitialSync` and `triggerImmediateSync` REMOVED — both existed solely to soften local-bridge auth-wedge, which is now categorically rejected upstream.) | +20 |
| `packages/security/permissions-nexus/src/nexus-permission-backend.test.ts` | New tests: false before any sync; false when first sync fails (404/parse/rebuild mismatch — no last-known-good); true after first successful sync; stays true when subsequent sync fails (last-known-good preserved); stays true when subsequent sync produces incompatible policy (skipped, last-known-good preserved) | +60 |
| `packages/meta/cli/src/runtime-factory.ts` | Type `nexusTransport` as base `NexusTransport` (long-lived session has no health); add `nexusBootMode`, `nexusPolicyPath`, `nexusAuditPoisonOnError`, `nexusPermissionsEnabled`, `nexusAuditEnabled`, `nexusAuditMode`, `nexusSyncIntervalMs`, `nexusProbeFactory` config fields; **Phase 1 deprecation (both transports):** unset `nexusPermissionsEnabled`/`nexusAuditEnabled` infers a transport-appropriate default + warns. HTTP infers TRUE (preserves v2 wiring). Local-bridge infers FALSE (matches new security posture; existing v2 wiring is intentionally skipped — warning surfaces this). Phase 2 (next release) makes ALL unset cases throw. Local-bridge + explicit `nexusPermissionsEnabled=true` THROWS (security gate, both phases). **Probe + consumer wiring gated on resolved flags:** if `permsEnabled === false && auditEnabled === false`, the entire Nexus startup block is SKIPPED — fs-only Nexus sessions unaffected. probe-factory is OPTIONAL on local-bridge (no Nexus consumer is wired there post-Round-4 — probe is observability-only); preflight: throw on local-bridge + fail-closed-* (unsupported); probe via factory for local-bridge, in-place for HTTP; thread `nexusPolicyPath` into BOTH `health()` readPaths AND `createNexusPermissionBackend`; telemetry mode: log probe failure but always wire consumers; fail-closed-* throws on probe failure; in `assert-remote-policy-loaded-at-boot`, await `nexusPermBackend.ready` and check `isCentralizedPolicyActive()`; **preserve per-sink poison latches (NDJSON, SQLite, Nexus each independent) AND existing per-sink fail-stop admission semantics** — pre-PR NDJSON/SQLite required-sink behavior is unchanged; Nexus joins on the same terms when `nexusAuditPoisonOnError === true`. NO quorum gate. Optional sinks (default) log only; **add early-throw validation** when `local-bridge + telemetry + nexusSyncIntervalMs===0` (deferred sync would never fire, deadlocking `ready`); route Nexus sink errors into it ONLY when `nexusAuditPoisonOnError === true` (default best-effort); existing middleware admission guards now cover Nexus too via per-sink poison latch; **wire Nexus compliance-recorder `onError` to `process.exit(1)` in opt-in mode (matches NDJSON/SQLite at `runtime-factory.ts:3058-3059`); best-effort logging in default mode (was silent — bug fix)** | +145 |
| `packages/security/audit-sink-nexus/src/config.ts` | **Add `onError?: (err: unknown) => void` to `NexusAuditSinkConfig`** — the field doesn't exist today; wrapper depends on it | +8 |
| `packages/security/audit-sink-nexus/src/nexus-sink.ts` | Remove silent `.catch(() => {})` on `startFlush()`; invoke `config.onError?.(err)` on flush failure (interval-triggered AND size-triggered AND explicit-flush-triggered paths must all route through `onError`) | +12 |
| `packages/security/audit-sink-nexus/src/nexus-sink.test.ts` | New: interval-triggered flush failure invokes `onError`; size-triggered flush failure invokes `onError`; explicit `flush()` failure invokes `onError`; `onError` undefined doesn't crash (regression guard against silent swallowing) | +60 |
| `packages/meta/cli/src/__tests__/runtime-factory-nexus-audit-poison.test.ts` | New tests: default (`nexusAuditPoisonOnError` unset) — Nexus middleware errors stay out of per-sink poison latch; admission boundaries do NOT block; best-effort preserved. Opt-in (`true`) — Nexus middleware error latches shared `auditPoisonError`; admission boundaries refuse work. **Compliance-recorder coverage (both modes):** default — failure logs warning (was silent regression); opt-in — failure invokes `process.exit(1)` callback (mocked in test). Matches NDJSON/SQLite test parity for both paths | +200 |
| `packages/meta/cli/src/__tests__/runtime-factory-health.test.ts` | New tests covering all three modes + activation race coverage (see Tests section) | +200 |
| `packages/meta/cli/src/tui-command.ts` | Drop the `as unknown as NexusTransport` cast at line 1704 — fs-nexus local-bridge transport now structurally satisfies base `NexusTransport` directly (after fs-nexus adds `kind: "local-bridge"` discriminator). **Architectural decoupling (this PR):** when neither `nexusPermissionsEnabled` nor `nexusAuditEnabled` resolves to true, do NOT pass `nexusTransport` into `createKoiRuntime` at all — fs-only sessions use the local-bridge transport directly through the fs-nexus path and bypass the Nexus consumer block entirely. This eliminates the contradictory upgrade tradeoff (warn-and-infer-false vs hard-throw on no-flags): callers reaching the Nexus block always intentionally enabled at least one consumer. When constructed, the probe factory captures its own copy of the spawn config. | +20 |
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
7h. `local-bridge + assert-remote-policy-loaded-at-boot mode: throws config validation error (unsupported)`
7g2. `local-bridge WITHOUT nexusProbeFactory: probe SKIPPED silently regardless of resolved consumer flags` (after Round 4: local-bridge never wires a Nexus consumer, so probe is observability-only)
7g2b. `local-bridge WITH nexusProbeFactory: probe runs for telemetry; result logged; does NOT block boot regardless of outcome`
7g3. `local-bridge + telemetry mode WITH nexusProbeFactory: probe runs via factory; success logs probeScope=spawn-config-validated`
7g4. `HTTP transport probe success logs probeScope=session-validated; local-bridge probe success NEVER logs session-validated`
7g5. `long-lived local-bridge transport object does NOT have a health method` (regression guard against unsafe in-place probing)
7g6. (REMOVED — deferInitialSync no longer exists; mitigation was for local-bridge permissions which are now categorically rejected)
7g7. (REMOVED — same)
7g8. (REMOVED — same)
7g10. (REMOVED — deferred-sync deadlock case no longer reachable)
7g11. `Required NDJSON sink failure latches ndjsonPoison; admission DENIED on next boundary` (per-sink fail-stop preserved — matches pre-PR semantics exactly)
7g12. `Required SQLite sink failure latches sqlitePoison; admission DENIED on next boundary` (per-sink fail-stop, regardless of NDJSON state)
7g12b. `Optional (non-required) sink poisoned: admission CONTINUES; failure logged only` (optional sinks never block)
7g12c. `Nexus with nexusAuditPoisonOnError=true poisoned: admission DENIED on next boundary` (Nexus joins per-sink fail-stop; no quorum)
7g12d. `Nexus with nexusAuditPoisonOnError=false poisoned: admission CONTINUES; failure logged` (best-effort default has no admission impact)
7g12e. `Pre-PR NDJSON+SQLite both required, NDJSON-only failure halts admission: behavior UNCHANGED` (regression guard against quorum drift)
7g13. (REMOVED — superseded by 7g16o which throws rather than warns)
7g14. `local-bridge + audit-enabled WITHOUT nexusAuditMode: throws config error at boot` (security gate; no implicit-default fallback for local-bridge audit)
7g15. (REMOVED — "require" mode no longer exists; local-bridge audit always skips the Nexus sink)
7g16. `local-bridge + nexusAuditMode="local-only" + NDJSON sink configured: Nexus sink skipped; boot succeeds`
7g16b. `local-bridge + nexusAuditMode="local-only" + NO local sinks: throws config error (prevents silent audit data loss)`
7g16c. `local-bridge + nexusAuditMode="disabled": Nexus sink skipped; no fallback assertion; boot succeeds`
7g16d. `HTTP transport: nexusAuditMode ignored; sink always wired`
7g16e. `nexusPermissionsEnabled=true + local-bridge: throws security gate at boot in BOTH phases` (no warn-and-continue path; no migration table fall-through)
7g16f. `nexusPermissionsEnabled=true + HTTP: wired normally`
7g16g. (REMOVED — nexusPermissionsOnLocalBridgeAck no longer exists)
7g16h. `nexusTransport set + nexusPermissionsEnabled UNSET: Phase 1 — boots with deprecation warning, infers true (existing v2 behavior); Phase 2 — throws`
7g16i. `nexusPermissionsEnabled=false explicitly: permissions skipped; no warning; audit-only deployment boots`
7g16j. `nexusPermissionsEnabled=true + HTTP: permissions wired normally`
7g16j2. `nexusTransport set + nexusAuditEnabled UNSET: Phase 1 — same warning + infer-true; Phase 2 — throws`
7g16j3. `nexusAuditEnabled=false: Nexus audit sink skipped regardless of nexusAuditMode value`
7g16j4. `nexusAuditEnabled=true + HTTP: nexusAuditMode ignored; sink wired (HTTP has no wedge surface)`
7g16j5. `local-bridge + nexusAuditEnabled=false: nexusAuditMode is NOT required (regression guard — backward-compat scoping)`
7g16j6. `Phase 1 deprecation warning fires for both HTTP and local-bridge unset flags; warning content differs by transport kind` (HTTP: "infers true"; local-bridge: "infers false + existing wiring SKIPPED")
7g16j7. `Both consumers explicitly false (any transport): startup probe is SKIPPED entirely; runtime does not call probeTransport.health()` (fs-only Nexus session — probe is none of this block's concern)
7g16j8. `Both consumers inferred false on local-bridge no-flags: probe SKIPPED` (consistent with explicit-false path)
7g16j9. `One consumer enabled: probe runs as before` (regression guard against over-eager skip)
7g16j10. `nexusProbeFactory throws synchronously: caught + logged in telemetry mode; boot CONTINUES; probe SKIPPED` (advisory contract preserved against spawn errors)
7g16j11. `local-bridge + auditEnabled=true + nexusAuditMode="disabled": probe + boot-mode preflight SKIPPED` (effective-consumer gating — disabled-by-mode does not trigger Nexus startup work)
7g16j12. `local-bridge + auditEnabled=true + nexusAuditMode="local-only": same as above (no Nexus consumer effectively wired on local-bridge)`
7g16j13. `HTTP + auditEnabled=true + nexusAuditMode="disabled": probe SKIPPED (effective-audit-wired is false even on HTTP when mode=disabled)`
7g16k. (REMOVED — local-bridge + permissions categorically rejected)
7g16l. (REMOVED — same)
7g16m. (REMOVED — same)
7g16n. (REMOVED — same)
7g16o. `local-bridge + nexusAuditPoisonOnError=true: throws config error at boot REGARDLESS of nexusAuditMode` (security gate fires before mode-specific gating — message names HTTP migration path)
7g16p. (REMOVED — single-flight contract no longer needed; triggerImmediateSync gone)
7g16q. (REMOVED — same)
7g16r. (REMOVED — same)
7g16s. (REMOVED — same)
7g16t. (REMOVED — same)
7g16u. `assertProductionTransport throws when transport.kind is undefined` (regression guard against silent HTTP misclassification of stale adapters)
7g16v. `assertProductionTransport returns transport unchanged when kind is set` (positive narrowing)
7g16w. `runtime-factory uses assertProductionTransport at every kind branch (no raw access to .kind)` (lint-style assertion via grep in test suite)
7g16x. `KOI_NEXUS_AUDIT_MODE=require: CLI parser rejects with actionable error naming local-only/disabled` (legacy value handling — old automation fails loud, not silent)
7g16y. `Phase 1 local-bridge with no flags: BOOTS, infers permissions=false AND audit=false, logs deprecation warning naming both flags AND scope-of-change ('existing v2 wiring is being SKIPPED')` (preserves fs-only sessions; explicit warning makes posture change visible)
7g16z. `Phase 1 local-bridge + nexusAuditEnabled=true (explicit) + no nexusAuditMode: throws audit-gate` (security gate fires on explicit opt-in)
7g16aa. `Phase 1 local-bridge + nexusPermissionsEnabled=true (explicit): throws permissions security gate (no fall-through, no warning-only path, no Phase-2-deferral)`
7g16ab. (REMOVED — probe-factory is no longer required on local-bridge; previous gate-via-resolved-flags test obsolete after Round 4)
7g17. `assert-remote-policy-loaded-at-boot: post-boot 404 on policy file does NOT demote node — last-known-good preserved; isCentralizedPolicyActive stays true; no second gate trigger` (regression guard for naming claim — "loaded" not "fresh")
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
13. `assert-remote-policy-loaded-at-boot: awaits backend.ready before exposing runtime`
14. `assert-remote-policy-loaded-at-boot: throws when first sync fails (no last-known-good) — file 404, no remote backend ever activated`
15. `assert-remote-policy-loaded-at-boot: throws when first sync fails — parse error`
16. `assert-remote-policy-loaded-at-boot: throws when first sync fails — rebuild shape mismatch`
17. `assert-remote-policy-loaded-at-boot: succeeds when first sync succeeds (isCentralizedPolicyActive === true)`
17b. `assert-remote-policy-loaded-at-boot: post-boot transient failure does NOT re-trigger gate — last-known-good remote policy preserved` (regression guard for availability)
18. `assert-remote-policy-loaded-at-boot: NO permission check executes against local backend before policy ready` — race coverage
19. `default mode is "telemetry" regardless of audit wiring` (honest contract)
20. `explicit nexusBootMode override always wins`
21. `skips preflight when nexusTransport is undefined`
22. `fail-closed-transport / assert-remote-policy-loaded-at-boot error messages include nexus error code`
23. `existing local-first golden test still passes (telemetry default)` — regression guard

`packages/lib/fs-nexus/src/local-transport.test.ts` (additions):

16. **NEGATIVE: long-lived local-bridge transport object does NOT have a `health` method** (regression guard against the spec contradiction caught in review — health belongs ONLY on the disposable probe variant)

`packages/lib/fs-nexus/src/probe-transport.test.ts` (additions — moved from local-transport):

20. `probe health() returns ok when freshly-spawned subprocess responds to version + reads`
21. `probe health() returns error when subprocess has exited before probe`
22. `probe health() returns error when stdio handshake fails before probes complete`
23. `probe subprocess is killed after health() regardless of result`

Existing `transport.test.ts` continues to pass unchanged.

## Config wiring (CLI ↔ runtime-factory ↔ env)

The new `KoiRuntimeFactoryConfig` fields need a public input surface. This PR wires them through the existing CLI/env path that already carries `nexusTransport`:

| New field | Env var | CLI flag | Default if unset |
|---|---|---|---|
| `nexusPermissionsEnabled` | `KOI_NEXUS_PERMISSIONS` (tri-state: `true`/`1`/`false`/`0`) | `--nexus-permissions` / `--no-nexus-permissions` (mutually exclusive) | unset → Phase 1: infer true + warn; Phase 2: throws |
| `nexusAuditEnabled` | `KOI_NEXUS_AUDIT` (tri-state: `true`/`1`/`false`/`0`) | `--nexus-audit` / `--no-nexus-audit` (mutually exclusive) | unset → Phase 1: infer true + warn; Phase 2: throws |
| `nexusAuditMode` | `KOI_NEXUS_AUDIT_MODE` (=`local-only`/`disabled`) | `--nexus-audit-mode <m>` | unset (only required for local-bridge + audit-enabled). `require` is REJECTED with actionable error — that mode was removed; local-bridge audit always skips Nexus sink |
| `nexusAuditPoisonOnError` | `KOI_NEXUS_AUDIT_POISON` (tri-state) | `--nexus-audit-poison` / `--no-nexus-audit-poison` | false |
| `nexusBootMode` | `KOI_NEXUS_BOOT_MODE` (=`telemetry`/`fail-closed-transport`/`assert-remote-policy-loaded-at-boot`) | `--nexus-boot-mode <m>` | `telemetry` |
| `nexusPolicyPath` | `KOI_NEXUS_POLICY_PATH` | `--nexus-policy-path <p>` | `koi/permissions` |
| `nexusSyncIntervalMs` | `KOI_NEXUS_SYNC_INTERVAL_MS` | `--nexus-sync-interval-ms <n>` | `30000` |
| `nexusProbeFactory` | n/a (programmatic only — sealed capability holding spawn config) | n/a | constructed in `tui-command.ts` from already-resolved spawn config when transport is local-bridge |

**Tri-state parsing:** booleans accept `true`/`1` → true, `false`/`0` → false, anything else (including unset) → undefined (which triggers the explicit-decision throw for required fields). The CLI parser rejects ambiguous combinations (e.g., both `--nexus-permissions` and `--no-nexus-permissions` on the same invocation). Existing CLI/env-driven deployments need at minimum:

```bash
# Migration one-liner (HTTP transport, both consumers active — preserves v2 behavior)
KOI_NEXUS_PERMISSIONS=true KOI_NEXUS_AUDIT=true koi up

# Audit-only deployment
KOI_NEXUS_PERMISSIONS=false KOI_NEXUS_AUDIT=true koi up

# Permissions-only (HTTP only — local-bridge throws)
KOI_NEXUS_PERMISSIONS=true KOI_NEXUS_AUDIT=false koi up
```

The CLI parser in `tui-command.ts` reads env + flag, validates, and passes the typed object into `createKoiRuntime(config)`. Existing flags/env keys are unchanged. New `tui-command.ts` work counted in the existing line in the file table (estimate updated +20 LOC for arg parsing). `nexusProbeFactory` is constructed inline in `tui-command.ts` whenever the resolved transport is local-bridge — operators do NOT set it directly; the CLI captures the same spawn config it used to construct the long-lived transport and passes a closure that spawns a fresh probe instance on demand.

## Migration (existing v2 deployments) — two-phase rollout

Existing v2 callers that pass `nexusTransport` already get Nexus permissions and audit wired implicitly. This PR makes both consumers explicit, but adopts a deprecation window so healthy boots are not broken on upgrade.

**Phase 1 — this PR (warn-only for unset flags on both transports; hard throw only for explicit unsafe combinations and other security gates):**

| Existing behavior | Phase 1 result | Recommended action |
|---|---|---|
| `nexusTransport` set + HTTP (no flags) | Boots; logs deprecation warning naming `nexusPermissionsEnabled`/`nexusAuditEnabled`; infers BOTH true | Set both flags explicitly to silence warning |
| `nexusTransport` + local-bridge (no flags) | Boots; logs deprecation warning naming `nexusPermissionsEnabled→false` / `nexusAuditEnabled→false` AND scope-of-change ("existing v2 wiring is being SKIPPED"). Existing fs-only TUI sessions continue to work. | Set both flags explicitly to silence warning. Wiring Nexus consumers on local-bridge requires explicit `true` (which then triggers downstream security gates). |
| `nexusTransport` + local-bridge + explicit `nexusPermissionsEnabled=true` | THROWS (security gate, both phases) | No migration — switch to HTTP transport |
| `nexusTransport` + local-bridge + explicit `nexusAuditEnabled=true` + no `nexusAuditMode` | THROWS (security gate) | Set `nexusAuditMode: "local-only"` (with NDJSON/SQLite) or `"disabled"` |
| `nexusTransport` + local-bridge + explicit `nexusAuditEnabled=true` without `nexusAuditMode` | THROWS (security gate) — `nexusAuditMode` required (note: "inferred" no longer reachable, since local-bridge no-flags now throws upstream) | Set `local-only` (with NDJSON/SQLite sink) or `disabled` |
| `nexusAuditPoisonOnError=true` + local-bridge | THROWS (security gate) — known wedge fault | Use HTTP for fail-stop audit |
| `nexusTransport.kind` undefined on a non-test transport | THROWS (security gate) — fail-closed assertion | Construct via named factory |

**Phase 2 — next release (separate issue, NOT this PR):**

- All transports: unset `nexusPermissionsEnabled` / `nexusAuditEnabled` → throws (currently warns + infers).
- Local-bridge + explicit `nexusPermissionsEnabled=true`: already throws in Phase 1; no change.
- All other security gates unchanged across phases.

The two-phase split keeps healthy v2 deployments running while giving operators and CI templates a release cycle to update. Security-relevant gates throw immediately; config-skew only warns.

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
