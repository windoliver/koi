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
6. **Local-bridge probing is constrained.** The fs-nexus `local-bridge` cannot be cleanly probed in-place without risk: its subprocess serializes one in-flight call, has no protocol-level cancel that doesn't poison the channel, and a wedged auth flow blocks every queued call. The two honest options for probing have unacceptable downsides under fail-closed semantics:

   | Probe target | Pros | Cons under fail-closed |
   |---|---|---|
   | Live session transport | Real validation | Auth blip wedges session — startup-only probe causes non-recoverable transport failure for the whole run |
   | Disposable fresh subprocess | Session safe | Validates spawn config + code paths only, NOT the live session — fail-closed guarantee would be misleading |

   **Resolution:**

   - **HTTP transport:** probe in place (no auth flow risk). All boot modes supported.
   - **local-bridge + `telemetry` (default):** probe via a disposable subprocess. Session-safe; the probe is advisory anyway. **The transport object never exposes spawn config or credentials.** A separate `nexusProbeFactory` is passed to `runtime-factory` by the caller (e.g., `tui-command.ts`) which constructs the disposable probe with the same spawn config but in a sealed capability — runtime-wide code can't read secrets from it.
   - **local-bridge + `fail-closed-transport` / `fail-closed-policy-at-boot`:** **NOT SUPPORTED.** Throws a config validation error at startup. Both implementation options would produce wrong behavior (session-wedge or false-guarantee). Once the bridge gains a non-poisoning cancel/reset (out of scope), this restriction can be lifted. Operators needing fail-closed must use HTTP transport.

   API surface:
   - `createLocalBridgeTransport(config)` → long-lived session transport (no probe support exposed)
   - `createLocalBridgeProbeTransport(spawnConfig)` → disposable transport that closes after one `health()` call. Caller passes spawn config; transport object does NOT retain it after spawn.
   - `KoiRuntimeFactoryConfig.nexusProbeFactory?: () => HealthCapableNexusTransport` — caller-supplied factory for probe construction. Required when `nexusTransport.kind === "local-bridge"` AND `nexusBootMode === "telemetry"`. Not stored on the runtime; called once during boot then discarded.

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

## Startup integration (telemetry by default, opt-in fail-closed-transport / fail-closed-policy-at-boot)

The real production boundary is `packages/meta/cli/src/runtime-factory.ts:832` (`KoiRuntimeFactoryConfig.nexusTransport`). The runtime factory wires Nexus into `createNexusPermissionBackend` and `createNexusAuditSink`.

**Critical existing contract: local-first permissions.** `createNexusPermissionBackend` is documented as "local-first: TUI rules apply when Nexus has no policy or is unreachable." A golden test in `meta/runtime/src/__tests__/golden-replay.test.ts` proves this fallback. **A fail-closed startup gate would break this contract** and convert recoverable Nexus outages into total runtime unavailability. That is a regression.

**Decision: telemetry-by-default for everything; fail-closed-transport and fail-closed-policy-at-boot are explicit opt-ins.**

Earlier drafts proposed making audit-wired runtimes default to `fail-closed-transport`. That was wrong: `health()` does NOT probe the audit write path (no non-side-effecting audit RPC exists today), so defaulting to fail-closed for audit gives a **false safety signal**. Better to be honest: telemetry default for everything, document the audit-write gap, and let operators opt in.

| Mode | Behavior |
|---|---|
| `telemetry` (default) | log on transport failure; log activation status; continue boot |
| `fail-closed-transport` | throw on transport failure for any of the 3 probes (version + version.json read + policy.json read); does NOT validate that policy files exist or that backend successfully activates remote policy |
| `fail-closed-policy-at-boot` | throw on transport failure; throw on first-sync policy-activation failure (awaits `backend.ready`). **STARTUP GATE ONLY** — does NOT enforce ongoing policy freshness. After successful boot, last-known-good remote policy continues to be served per existing semantics even if subsequent syncs fail or produce incompatible policy. Operators needing ongoing freshness enforcement need a separate mechanism (out of scope this PR). |

**⚠️ Security caveat for `fail-closed-transport`:** this gate only proves the transport can carry the read calls. Even with a 404 on `version.json`/`policy.json` the probe succeeds (file-not-found is a transport-success signal). And even when the files exist, parsing or backend `rebuildBackend` shape mismatch can still cause silent local-fallback. Operators who require centralized-policy *enforcement* must use `fail-closed-policy-at-boot`, not `fail-closed-transport`. The two-name split is deliberate so this caveat cannot be papered over by mode-name optimism.

**Policy-activation check** (only in `fail-closed-policy-at-boot`):

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

When `nexusAuditPoisonOnError === true`, the runtime composes `createNexusAuditSink` with a thin wrapper that conforms to the existing `AuditSink` interface (`log()` required, `flush?` optional, `query?` optional):

```ts
function createPoisonGuardedNexusAuditSink(opts: {
  transport: HealthCapableNexusTransport;
  onError: (err: unknown) => void;
}): AuditSink {
  let poisonErr: unknown;
  const inner = createNexusAuditSink({
    transport: opts.transport,
    onError: (err) => {
      if (poisonErr === undefined) poisonErr = err;
      opts.onError(err);
    },
  });
  return {
    log: (entry) => {
      if (poisonErr !== undefined) throw new Error("nexus audit sink poisoned", { cause: poisonErr });
      return inner.log(entry);
    },
    flush: inner.flush === undefined ? undefined : async () => {
      await inner.flush?.();
      if (poisonErr !== undefined) throw new Error("nexus audit flush failed", { cause: poisonErr });
    },
    query: inner.query,  // pass through unchanged — preserves ledger/query surface
  };
}
```

**Honest semantics — fail-stop is at flush boundaries, not at log time:**

The Nexus sink is buffered. `log()` returns synchronously after enqueueing; the actual write happens later via interval/size/explicit flush. Therefore the wrapper's `log()` cannot fail-stop on the *first lost write* — only on subsequent writes after `onError` has fired. Concretely:

- Write A enqueued → log returns ok
- Background flush A fails → `onError` fires → poison latched → `opts.onError` invoked (operator sees log immediately)
- Write B enqueued → wrapper's `log()` throws (poisoned)

So write A appears successful even though it was lost. The window matters: any work the runtime does between A's enqueue and B's log call proceeds against a sink that has already failed.

**Closing the window requires middleware-boundary flushes**, which the existing audit middleware already performs at session-end and other durability points. This PR adds: middleware MUST `await sink.flush()` at every durability boundary it currently has, and the wrapper's `flush()` rethrows. After the first poisoned flush, every subsequent `log()` also throws. So:

- The first lost write is observed at the **next middleware flush boundary**, not at the next `log()`
- Operators get an immediate `onError` log when the failure happens
- Subsequent writes hard-fail
- Every middleware-driven flush hard-fails

This matches the NDJSON/SQLite pattern (those sinks are also buffered; their guard catches at flush time too). The spec previously implied first-call latching, which is impossible against a buffered sink without making `log()` fully synchronous (expensive and orthogonal). The honest contract is "fail-stop at flush boundaries" — documented explicitly.

**Default (telemetry mode, `nexusAuditPoisonOnError` unset):** Nexus audit remains best-effort. Failures are logged via `onError` but do not abort writes or rethrow at flush. Same observable behavior as today.

**Opt-in (`nexusAuditPoisonOnError: true`):** Full guard model — first failure latches, subsequent `log()` calls throw, every middleware flush boundary rethrows. Matches NDJSON/SQLite semantics. Compatible with any `nexusBootMode`.

**Sink-side change (always applies):**

`NexusAuditSinkConfig` does NOT currently expose an `onError` field — the existing config has only `transport`, `basePath`, `batchSize`, `flushIntervalMs`. This PR **adds** `onError?: (err: unknown) => void` to the public API in `packages/security/audit-sink-nexus/src/config.ts`. Without this, the wrapper has no observable signal for interval-triggered flush failures and the silent-drop bug remains.

`packages/security/audit-sink-nexus/src/nexus-sink.ts` then:
- Removes silent `.catch(() => {})` on `startFlush()`
- Routes failures from interval-triggered, size-triggered, AND explicit `flush()` paths through `config.onError?.(err)`
- Tested at all three trigger points to prove no path silently drops

This sink-side change is correct regardless of whether the operator opts into poison-guard — silent swallowing is a bug. Best-effort mode (default) gets logged warnings; poison-guard mode (opt-in) gets latch + rethrow.

**Remaining gap (server-side, out of scope):** `health()` still does not probe audit *write* readiness — no non-side-effecting audit RPC exists on the Nexus server. The opt-in poison-guard plus sink-side fix close the runtime observability and propagation gaps; they do not move detection to startup. A server-side `audit.ping` RPC would close that remaining gap; tracked as a separate Nexus server issue.

```ts
// packages/meta/cli/src/runtime-factory.ts
import type { HealthCapableNexusTransport } from "@koi/nexus-client";

type NexusBootMode = "telemetry" | "fail-closed-transport" | "fail-closed-policy-at-boot";

interface KoiRuntimeFactoryConfig {
  // …
  readonly nexusTransport?: HealthCapableNexusTransport | undefined;
  /**
   * Base path under which the Nexus permission backend stores `version.json`
   * and `policy.json`. Defaults to "koi/permissions". MUST be threaded into
   * BOTH `createNexusPermissionBackend` AND the `health()` probe so the
   * readiness check validates the same namespace the backend will read.
   * Mismatch produces false readiness signals.
   */
  readonly nexusPolicyBasePath?: string | undefined;
  /**
   * Caller-supplied factory for constructing a disposable probe transport.
   * REQUIRED when `nexusTransport.kind === "local-bridge"` and
   * `nexusBootMode === "telemetry"`. Called once during boot, result is closed
   * after the probe. The runtime never stores spawn config / credentials on
   * the long-lived transport, so secrets stay in this sealed capability.
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
   * - "fail-closed-policy-at-boot": throw on transport failure OR first-sync
   *   policy-activation failure (awaits backend.ready and inspects
   *   isCentralizedPolicyActive()). STARTUP GATE ONLY — does not enforce
   *   ongoing policy freshness; last-known-good remote policy continues to
   *   be served after sync failures.
   */
  readonly nexusBootMode?: NexusBootMode | undefined;
}

export async function createKoiRuntime(config: KoiRuntimeFactoryConfig) {
  // … existing setup …
  if (config.nexusTransport !== undefined) {
    const mode: NexusBootMode = config.nexusBootMode ?? "telemetry";
    const policyBase = config.nexusPolicyBasePath ?? "koi/permissions";

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
    if (config.nexusTransport.kind === "local-bridge"
        && mode !== "telemetry") {
      throw new Error(
        `nexusBootMode=${mode} is not supported for local-bridge transports. ` +
        `Use HTTP transport or nexusBootMode="telemetry". ` +
        `(Local-bridge cannot be probed without risking session wedge on auth challenges; ` +
        `probing a disposable subprocess would not validate the live session, so the ` +
        `fail-closed-* guarantee would be misleading.)`,
      );
    }

    const probeTransport = config.nexusTransport.kind === "local-bridge"
      ? config.nexusProbeFactory!()  // factory-provided; NEVER reads secrets from transport
      : config.nexusTransport;
    let health;
    try {
      health = await probeTransport.health({
        readPaths: [`${policyBase}/version.json`, `${policyBase}/policy.json`],
      });
    } finally {
      if (probeTransport !== config.nexusTransport) probeTransport.close();
    }

    // Step 2: branch on probe result + boot mode.
    // KEY INVARIANT: telemetry mode is ADVISORY ONLY — probe failures are logged
    // but do NOT suppress consumer wiring. The existing local-first / polling
    // recovery semantics in createNexusPermissionBackend already handle transient
    // outages correctly, and the runtime currently always wires Nexus audit when
    // a transport exists. Suppressing wiring on probe failure would be a behavior
    // regression: a startup blip would permanently lose centralized policy sync
    // and Nexus audit for the whole session.
    if (!health.ok) {
      const msg = `Nexus transport unhealthy: ${health.error.message} (code=${health.error.code})`;
      if (mode === "telemetry") {
        logger.warn({ err: health.error }, msg);
        // Fall through — wire consumers anyway; backend will retry per existing semantics.
      } else {
        throw new Error(msg, { cause: health.error });  // fail-closed-* throws
      }
    } else {
      logger.info({ latencyMs: health.value.latencyMs, version: health.value.version,
                    probed: health.value.probed }, "nexus transport ok");
    }
  }

  // Step 3: wire nexus consumers — wiring is gated ONLY by whether nexusTransport
  // was configured, NOT by probe outcome. Telemetry probe is advisory.
  let nexusPermBackend;
  if (config.nexusTransport !== undefined) {
    nexusPermBackend = createNexusPermissionBackend({
      transport: config.nexusTransport,
      policyBasePath: config.nexusPolicyBasePath ?? "koi/permissions",
      // … existing config …
    });

    // Step 4: policy-activation check — ONLY in fail-closed-policy-at-boot mode.
    // Note: this is the ONE place probe outcome AND wiring outcome must agree —
    // we get here because the probe succeeded (otherwise step 2 threw), then
    // we additionally require the first sync to actually activate remote policy.
    if ((config.nexusBootMode ?? "telemetry") === "fail-closed-policy-at-boot") {
      await nexusPermBackend.ready;
      if (!nexusPermBackend.isCentralizedPolicyActive()) {
        throw new Error(
          "Nexus centralized policy not active after first sync (file missing, parse error, or backend rebuild failed); " +
          "fail-closed-policy-at-boot mode requires active centralized policy at boot",
        );
      }
    }
    // telemetry / fail-closed-transport: do NOT await ready (preserves existing async semantics)
  }

  // Step 5: wire Nexus audit sink. Poison-guard is OPT-IN via nexusAuditPoisonOnError.
  // Default (best-effort) preserves existing telemetry-mode behavior — failures
  // are logged but do not abort writes.
  if (config.nexusTransport !== undefined) {
    const sink = config.nexusAuditPoisonOnError === true
      ? createPoisonGuardedNexusAuditSink({
          transport: config.nexusTransport,
          onError: (err) => logger.error({ err }, "nexus audit write failed"),
        })
      : createNexusAuditSink({
          transport: config.nexusTransport,
          onError: (err) => logger.warn({ err }, "nexus audit write failed (best-effort)"),
        });
    auditSinks.push(sink);
  }
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

`fail-closed-policy-at-boot` checks this **once at startup** after `await backend.ready` completes — i.e., it asserts that the first sync produced a remote backend. Post-boot transient failures do not re-trigger the gate. The new mode adds a startup guarantee without changing steady-state behavior.

**Type-system enforcement:** field typed as `HealthCapableNexusTransport`. Production transports (`createHttpTransport`, fs-nexus `local-bridge`) must return this. TypeScript rejects a base `NexusTransport`. The `as unknown as NexusTransport` cast in `tui-command.ts:1704` becomes `assertHealthCapable(transport)`.

**Why this is the right policy:**

- Default mode preserves the existing local-first contract — no regression
- Operators get visibility into Nexus health via logs at every startup
- Compliance/security deployments opt in to `fail-closed-transport` or `fail-closed-policy-at-boot` explicitly
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
| `packages/lib/fs-nexus/src/local-transport.ts` | (1) Per-call `opts.deadlineMs`. (2) Per-call `opts.nonInteractive` — on `auth_required`: reject in-flight call locally; in disposable-probe path kill the subprocess; in session-probe (fail-closed) path the session may be wedged (accepted cost). (3) Add `kind: "local-bridge"` discriminator. (4) Implement `health(opts?)` via version + per-readPath probes through subprocess stdio. | +95 |
| `packages/lib/fs-nexus/src/transport.ts` | **Forward `health` from the wrapped HTTP transport** (currently this fs-nexus HTTP wrapper drops it, returning only `{ call, close, subscribe, submitAuthCode }`). Add `health` passthrough so the type contract upgrade in runtime-factory works for HTTP path. Add `kind: "http"` discriminator. | +20 |
| `packages/lib/fs-nexus/src/transport.test.ts` | New: HTTP wrapper forwards `health()` calls to underlying transport; result shape preserved; opts pass through | +50 |
| `packages/lib/fs-nexus/src/probe-transport.ts` | New: `createLocalBridgeProbeTransport(spawnConfig)` — spawns a fresh, short-lived bridge subprocess for one health() probe; closes itself unconditionally after probe completes. Uses the same JSON-RPC channel as the session transport but is throwaway. | +60 |
| `packages/lib/fs-nexus/src/probe-transport.test.ts` | New: probe spawns isolated subprocess; health() returns ok when bridge healthy; health() returns error when bridge auth-blocked (nonInteractive); probe subprocess is killed after probe regardless of result; probe failure does NOT affect any concurrently-running session transport | +110 |
| `packages/lib/fs-nexus/src/local-transport.test.ts` | New: per-call deadline rejects before transport default; long-lived session transport does NOT receive nonInteractive flag from runtime probe path; existing call/subscribe behavior unchanged | +80 |
| `packages/security/permissions-nexus/src/nexus-permission-backend.ts` | Add `isCentralizedPolicyActive(): boolean` — read-only query of currently-serving backend (true iff serving remote, regardless of latest sync outcome); preserves existing skip-bad-update behavior | +25 |
| `packages/security/permissions-nexus/src/nexus-permission-backend.test.ts` | New tests: false before any sync; false when first sync fails (404/parse/rebuild mismatch — no last-known-good); true after first successful sync; **stays true when subsequent sync fails** (last-known-good preserved); **stays true when subsequent sync produces incompatible policy** (skipped, last-known-good preserved) | +100 |
| `packages/meta/cli/src/runtime-factory.ts` | Type `nexusTransport` as `HealthCapableNexusTransport`; add `nexusBootMode`, `nexusPolicyBasePath`, **`nexusAuditPoisonOnError`** config fields; probe via `createLocalBridgeProbeTransport` for local-bridge (HTTP probes itself); thread `nexusPolicyBasePath` into BOTH `health()` readPaths AND `createNexusPermissionBackend`; telemetry mode: log probe failure but always wire consumers; fail-closed-* throws; in `fail-closed-policy-at-boot`, await `nexusPermBackend.ready` and check `isCentralizedPolicyActive()`; **wire Nexus audit via `createPoisonGuardedNexusAuditSink` ONLY when `nexusAuditPoisonOnError === true`; default best-effort** | +110 |
| `packages/meta/cli/src/poison-guarded-nexus-audit.ts` | New small helper: `createPoisonGuardedNexusAuditSink({ transport, onError }): AuditSink` — composes `createNexusAuditSink` with the poison-guard pattern, returns the standard `AuditSink` shape (`log`, optional `flush`, optional `query`); preserves `query` passthrough | +55 |
| `packages/meta/cli/src/poison-guarded-nexus-audit.test.ts` | New tests: simulated background flush failure latches via onError; SUBSEQUENT log() throws with cause chain (NOT the failing-write log call — that's the documented honest semantic); flush rethrows; success path passes through; query passes through unchanged; multiple errors keep first | +110 |
| `packages/security/audit-sink-nexus/src/config.ts` | **Add `onError?: (err: unknown) => void` to `NexusAuditSinkConfig`** — the field doesn't exist today; wrapper depends on it | +8 |
| `packages/security/audit-sink-nexus/src/nexus-sink.ts` | Remove silent `.catch(() => {})` on `startFlush()`; invoke `config.onError?.(err)` on flush failure (interval-triggered AND size-triggered AND explicit-flush-triggered paths must all route through `onError`) | +12 |
| `packages/security/audit-sink-nexus/src/nexus-sink.test.ts` | New: interval-triggered flush failure invokes `onError`; size-triggered flush failure invokes `onError`; explicit `flush()` failure invokes `onError`; `onError` undefined doesn't crash (regression guard against silent swallowing) | +60 |
| `packages/meta/cli/src/__tests__/runtime-factory-nexus-audit-poison.test.ts` | New tests: default (`nexusAuditPoisonOnError` unset) wires plain `createNexusAuditSink` — first failure logs warning, subsequent log() succeeds (best-effort preserved); opt-in (`nexusAuditPoisonOnError: true`) wires guarded sink — first failure poisons; subsequent log() throws; per-hook flush rethrows; integration with audit middleware boundaries | +140 |
| `packages/meta/cli/src/__tests__/runtime-factory-health.test.ts` | New tests covering all three modes + activation race coverage (see Tests section) | +200 |
| `packages/meta/cli/src/tui-command.ts` | Replace `as unknown as NexusTransport` cast (line 1704) with `assertHealthCapable(transport)` narrowing | +5 |
| `docs/L2/nexus-client.md` | Document readiness probe semantics; `HealthCapableNexusTransport` contract; WS/gRPC/pool out-of-scope rationale | +60 |

**Total: ~1110 LOC (335 src + 715 test + 60 doc).**

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
7d. `runtime-factory threads nexusPolicyBasePath into BOTH health() readPaths AND createNexusPermissionBackend` (mismatch is impossible)
7e. `default nexusPolicyBasePath is "koi/permissions" when config field omitted`
7f. `local-bridge + telemetry mode: probe spawns disposable subprocess (session not touched)`
7g. `local-bridge + fail-closed-transport mode: throws config validation error (unsupported)`
7h. `local-bridge + fail-closed-policy-at-boot mode: throws config validation error (unsupported)`
7g2. `local-bridge + telemetry mode without nexusProbeFactory: throws config validation error (factory required)`
7h2. `transport object does NOT expose spawn config / credentials` (security regression guard)
7i. `HTTP transport: always probes session directly regardless of mode (no auth flow risk)`
7j. `fs-nexus HTTP wrapper forwards health() to underlying transport (regression guard)`
8. `telemetry default: succeeds and logs warning on health() error` — local-first preserved
9. `telemetry: succeeds and logs info on transport ok`
10. `telemetry: does NOT await backend.ready` — preserves existing async semantics
11. `fail-closed-transport: throws on transport error`
12. `fail-closed-transport: does NOT await backend.ready` — only transport gate, no policy gate
13. `fail-closed-policy-at-boot: awaits backend.ready before exposing runtime`
14. `fail-closed-policy-at-boot: throws when first sync fails (no last-known-good) — file 404, no remote backend ever activated`
15. `fail-closed-policy-at-boot: throws when first sync fails — parse error`
16. `fail-closed-policy-at-boot: throws when first sync fails — rebuild shape mismatch`
17. `fail-closed-policy-at-boot: succeeds when first sync succeeds (isCentralizedPolicyActive === true)`
17b. `fail-closed-policy-at-boot: post-boot transient failure does NOT re-trigger gate — last-known-good remote policy preserved` (regression guard for availability)
18. `fail-closed-policy-at-boot: NO permission check executes against local backend before policy ready` — race coverage
19. `default mode is "telemetry" regardless of audit wiring` (honest contract)
20. `explicit nexusBootMode override always wins`
21. `skips preflight when nexusTransport is undefined`
22. `fail-closed-transport / fail-closed-policy-at-boot error messages include nexus error code`
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
