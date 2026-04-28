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
  /**
   * Caller-provided abort signal. When the signal aborts BEFORE the call
   * settles, transport MUST reject the in-flight call with `KoiError`
   * `code: "ABORTED"` AND release any subprocess/socket handles it owns
   * for the cancelled call. HTTP transport piggybacks on `fetch`'s
   * native `signal` plumbing; local-bridge transport adds an internal
   * pending-request map keyed by JSON-RPC id and responds to abort by
   * sending the bridge a cancel notification + rejecting the pending
   * call's promise. Required by `permission-backend.abortInFlightSync()`
   * (the assert-remote-policy-loaded-at-boot timeout path) — without
   * this option, the timeout would only abandon the promise while the
   * underlying read continued to mutate backend state after dispose.
   */
  readonly signal?: AbortSignal;
}

/**
 * Transport health result. Validates ONLY what nexus-client can know without
 * instantiating downstream consumers: TCP+TLS+JSON-RPC reachability and
 * version. Policy-activation readiness is the runtime's responsibility
 * (it owns the backend instance and can await `backend.ready`).
 *
 * Four-state status (forces callers to distinguish full validation from
 * version-only and from missing-namespace, instead of collapsing all
 * partial states into "ok" via a boolean check):
 *   - "ok": transport reachable AND every probe path (>=1) returned a
 *     valid 200. Reachability + namespace coverage both confirmed.
 *   - "version-only": transport reachable BUT no probe paths were
 *     supplied (caller passed `readPaths: []`). Version was probed; no
 *     policy / namespace coverage was attempted. Distinct from "ok" so a
 *     caller that gates on `status === "ok"` cannot misread a degraded
 *     audit-only probe as full readiness.
 *   - "missing-paths": transport reachable BUT one or more supplied probe
 *     paths returned 404 (policy namespace absent — control surface missing).
 *   - "error": transport unreachable / 5xx / auth failure / malformed
 *     payload (returned as `Result.error`, not part of this success union).
 *
 * Callers that only check `status === "ok"` get correct fail-closed behavior
 * by default. The earlier `ok: true` + optional `notFound[]` shape was
 * misuse-prone (boolean-readiness misread for missing-namespace); the
 * three-state status from Loop 4 R1 closed that hazard for missing-paths
 * but reused "ok" for empty-readPaths probes — Loop 4 R7 closes that one too.
 */
export type NexusHealth =
  | {
      readonly status: "ok";
      readonly version: string;
      readonly latencyMs: number;
      readonly probed: readonly string[];
    }
  | {
      readonly status: "version-only";
      readonly version: string;
      readonly latencyMs: number;
      /** Always `["version"]` — no read paths were supplied. Surfaced as a
       *  distinct status so dashboards and code that gate on `"ok"` cannot
       *  treat a probe with zero policy reads as fully validated. */
      readonly probed: readonly string[];
    }
  | {
      readonly status: "missing-paths";
      readonly version: string;
      readonly latencyMs: number;
      readonly probed: readonly string[];
      /** Probe paths that returned 404. Always non-empty when status===
       *  "missing-paths". nexus-client surfaces this as a non-success status
       *  so callers cannot treat it as healthy by accident; runtime-factory
       *  still treats it as fatal under assert-* boot modes (missing policy
       *  namespace) and as a warning in telemetry mode. */
      readonly notFound: readonly string[];
    };

/**
 * Transport kind discriminator. Public part of the contract — runtime
 * code branches on this for probe strategy selection (e.g., disposable
 * vs. session probe for local-bridge). Adding new transport kinds is
 * a public-API change.
 */
export type NexusTransportKind = "http" | "local-bridge";
// `kind` is OPTIONAL on the public base interface (preserves source-compat
// for test-only structural mocks AND for legacy in-tree adapters not yet
// migrated to set it). At the PRODUCTION runtime boundary (createKoiRuntime),
// `assertProductionTransport(t)` follows a TWO-PHASE rollout matching the
// permissions/audit flag rollout:
//
//   Phase 1 AND Phase 2: missing `kind` ALWAYS THROWS at the production
//     runtime boundary. Pre-PR, passing a `nexusTransport` implicitly wired
//     both Nexus permissions and audit. A "warn-and-skip" Phase 1 would
//     silently DROP both consumers on upgrade for any structural adapter
//     not yet migrated to set `kind` — exactly the auth/audit bypass we
//     want to prevent. Inferring "http" or "local-bridge" from shape is
//     equally unsafe (silent misroute). Failing loud is the only option
//     that preserves authorization and audit guarantees during migration.
//
//     The error message names every named factory and the explicit
//     opt-out path so operators have an immediate migration target:
//       "construct via createHttpTransport / createLocalBridgeTransport /
//        createLocalBridgeProbeTransport / fs-nexus HTTP wrapper, OR set
//        nexusPermissionsEnabled=false AND nexusAuditEnabled=false to
//        explicitly opt out of Nexus consumer wiring (transport will still
//        be used by other subsystems)."
//
//     The `explicitConsumerWanted` parameter is NO LONGER NEEDED — it
//     existed for the bifurcated Phase 1 behavior. The signature collapses
//     to `assertProductionTransport(t)` and the throw message is the same
//     in every case.
//
//   IMPORTANT — caller responsibility for the fs-only opt-out:
//     assertProductionTransport(t) ALWAYS throws on missing kind when called.
//     The fs-only escape hatch works by NOT calling the assertion at all.
//     `runtime-factory.ts` checks `nexusPermissionsEnabled === false &&
//     nexusAuditEnabled === false` BEFORE calling assertProductionTransport
//     and skips the assertion (and the entire Nexus block) when the operator
//     explicitly opted out of both consumers. This is the only place in the
//     codebase that gets to bypass the assertion; library code that hands a
//     transport off to the runtime must NOT call assertProductionTransport
//     itself.
//
// Production callers MUST construct via one of the named factories
// (createHttpTransport, createLocalBridgeTransport, fs-nexus HTTP wrapper,
// createLocalBridgeProbeTransport) which always set it.
//
// HONEST ROLLOUT FRAMING (recurring review concern, recorded across 6+
// adversarial-review rounds): missing `kind` IS a breaking change for any
// legacy structural adapter that does not stamp it. The "two-phase"
// language elsewhere in this spec applies to the consumer-flag rollout
// (HTTP unset perms/audit warns in Phase 1, throws in Phase 2). For
// missing `kind` there is NO Phase-1 grace period — both phases throw at
// the runtime boundary unless the caller takes the documented fs-only
// opt-out (explicit `nexusPermissionsEnabled=false` AND
// `nexusAuditEnabled=false`).
//
// Why no grace period for missing kind: every alternative considered was
// worse than a loud break.
//   - Skip + warn would silently DROP both Nexus consumers on upgrade for
//     any structural adapter not yet migrated — pre-PR semantics implicitly
//     wired both, so silent skip is an authorization/audit bypass.
//   - Infer "http" from shape would silently MISROUTE a stale local-bridge
//     adapter onto the in-place HTTP probe path — same security failure.
//
// The migration paths are explicit and documented: (a) construct via a
// named factory before passing the transport, OR (b) for fs-only callers
// that want to keep using a structural adapter for non-Nexus subsystems,
// set both consumer flags to `false`. There is no third option that
// preserves authorization/audit guarantees, and we will not ship one.
// `getTransportKind(t)` is RETIRED — use `assertProductionTransport(t).kind`
// so runtime branches narrow correctly (and so the throw is wired in
// exactly one place).

/** Base transport — minimal surface, satisfied by tests/mocks/fixtures. */
export interface NexusTransport {
  readonly kind?: NexusTransportKind | undefined;  // optional on base for test-only mocks; assertProductionTransport(t) THROWS at the production runtime boundary if undefined — never defaults
  readonly call: <T>(
    method: string,
    params: Record<string, unknown>,
    opts?: NexusCallOptions,  // per-call deadline / nonInteractive / signal
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
| **HTTP production transport** | `createHttpTransport` (this package) and the fs-nexus HTTP wrapper | **MUST implement** (probed in-place by runtime) |
| **Disposable local-bridge probe** | `createLocalBridgeProbeTransport` (fs-nexus) | **MUST implement** (constructed at caller-site only) |
| **Long-lived local-bridge session** | fs-nexus `local-bridge` transport returned by `createFsNexusTransport({ kind: "local-bridge", ... })` (long-running subprocess used for fs reads, audit, etc.) | **MUST NOT implement** — probing the live session can wedge the shared subprocess on `auth_required` (no protocol-level cancel). Health is exercised via the disposable probe variant instead. Runtime never invokes `health()` on a long-lived local-bridge transport. |
| **Test fixtures / mocks** | `fs-nexus/test-helpers.ts`, `testing.ts`, per-package test stubs | MAY omit (no startup path) |

The interface keeps `health` optional so fixtures don't need no-op stubs and so the long-lived local-bridge transport stays at base `NexusTransport`. Startup code enforces the HTTP requirement via a runtime guard (`assertHealthCapable`) at the HTTP probe site. This gives us:

1. Source compatibility for tests (no mass churn)
2. Fail-closed enforcement at the single HTTP boundary that the runtime actually probes
3. Clear error message when a non-HealthCapable HTTP transport reaches startup: "HTTP nexus transport is missing required `health()` method"
4. **Type-system enforcement that the unsafe in-place local-bridge probe path is impossible:** the long-lived local-bridge transport literally lacks `health()`, so an implementer cannot satisfy a misread "MUST implement" requirement by adding it to the live session — that contract row above is `MUST NOT`.

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
3. For each path in `opts.readPaths ?? DEFAULT_PROBE_PATHS`: `transport.call("read", { path }, { deadlineMs, nonInteractive: true })`. 200 with **valid payload shape** → record success for that path. 200 with malformed payload (not a string and not `{ content: string }`) → return `Result.error` with `code: "VALIDATION"` — the permission backend would fail to parse this same payload on first sync, so a 200 alone is insufficient signal. 404 → record the path under `notFound[]` (do NOT short-circuit; collect 404s for ALL paths). 5xx / network / auth → return `Result.error`. After all reads complete: if any path 404'd, return `Result.ok({ status: "missing-paths", notFound, ... })`; if every path succeeded with valid payload, return `Result.ok({ status: "ok", ... })`. Callers cannot mistake a missing namespace for healthy because "ok" and "missing-paths" are different discriminator values — a `result.value.status === "ok"` check is the minimum required handshake. Runtime-factory still decides outcome by mode: in `telemetry` `missing-paths` is a warning; in `assert-transport-reachable-at-boot` AND `assert-remote-policy-loaded-at-boot` it is FATAL because the policy namespace is missing. (Custom `readPaths` keep the same per-path 404 semantics; caller code that uses custom paths must still handle the `missing-paths` discriminator.)
4. **Payload extractor parity**: the `read`-payload validator MUST be the SAME function the permission backend uses. Sharing the extractor closes the false-negative gap where `health()` reports OK on a 200 with a malformed body that the permission backend would later reject as parse error and demote to local fallback. **The canonical `extractReadContent` lives in `@koi/nexus-client/extract-read-content`** (lowest layer that needs it; `@koi/permissions-nexus` is updated in this PR to import it instead of its current ad-hoc destructuring). One owner, one shape contract, no drift between probe and backend.
5. All calls go through `transport.call(...)` — local-bridge included.
6. **Local-bridge probing is constrained.** The fs-nexus `local-bridge` cannot be cleanly probed in-place without risk: its subprocess serializes one in-flight call, has no protocol-level cancel that doesn't poison the channel, and a wedged auth flow blocks every queued call. The two honest options for probing have unacceptable downsides under fail-closed semantics:

   | Probe target | Pros | Cons under fail-closed |
   |---|---|---|
   | Live session transport | Real validation | Auth blip wedges session — startup-only probe causes non-recoverable transport failure for the whole run |
   | Disposable fresh subprocess | Session safe | Validates spawn config + code paths only, NOT the live session — fail-closed guarantee would be misleading |

   **Resolution:**

   - **HTTP transport:** probe in place (no auth flow risk). All boot modes supported.
   - **local-bridge + `telemetry`:** the runtime does NOT probe. Operators who want telemetry can construct a disposable probe at the call site via the exported `createLocalBridgeProbeTransport` and log the result before calling `createKoiRuntime`. Caller-site responsibility — runtime block is HTTP-only.
   - **local-bridge + `assert-transport-reachable-at-boot` / `assert-remote-policy-loaded-at-boot`:** **NOT SUPPORTED.** Throws a config validation error at startup. Both implementation options would produce wrong behavior (session-wedge or false-guarantee). Once the bridge gains a non-poisoning cancel/reset (out of scope), this restriction can be lifted. Operators needing fail-closed must use HTTP transport.

   API surface:
   - `createLocalBridgeTransport(config)` → long-lived session transport (no probe support exposed)
   - `createLocalBridgeProbeTransport(spawnConfig)` → disposable transport that closes after one `health()` call. Caller passes spawn config; transport object does NOT retain it after spawn.
   - `KoiRuntimeFactoryConfig.nexusProbeFactory` — REMOVED. Runtime probes HTTP in place; local-bridge has no runtime probe path. Standalone probing remains available via the exported `createLocalBridgeProbeTransport` (called directly at the call site, not threaded through runtime config).

   This eliminates the credential-leak risk (transport is opaque; spawn secrets live in a sealed capability) AND avoids making misleading fail-closed claims for local-bridge.
7. Per-call `deadlineMs: HEALTH_DEADLINE_MS = 5_000` overrides each transport's default.
8. On success (one or more `readPaths` supplied AND every read returned a valid 200): `{ ok: true, value: { status: "ok", version, latencyMs, probed: ["version", "read:<path1>", ...] } }`.
8a. On version-only (`opts.readPaths` was `[]` so no reads ran): `{ ok: true, value: { status: "version-only", version, latencyMs, probed: ["version"] } }` — distinct status so a caller checking `status === "ok"` cannot misread a degraded audit-only probe as full validation.
8b. On namespace-absent (one or more reads returned 404, no other failure): `{ ok: true, value: { status: "missing-paths", version, latencyMs, probed, notFound: [<paths>] } }` — surfaces the gap as a non-"ok" status so a `status === "ok"` check fails closed.
9. On failure (transport/5xx/auth/malformed): propagate `KoiError` via `mapNexusError`.

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

The fs-nexus `local-bridge` transport is a spawned Python subprocess speaking JSON-RPC over stdin/stdout. The long-lived session transport does **NOT** implement `health()` — probing it is unsafe (auth wedge with no protocol-level cancel). Health is exposed **exclusively** by the disposable probe variant (`createLocalBridgeProbeTransport`), which spawns a fresh short-lived subprocess and executes the same `version` + `read("koi/permissions/version.json")` calls **through `transport.call(...)`** so the subprocess startup, IPC handshake, line parsing, and notification routing are all exercised. Direct in-process calls to bridge handlers are explicitly forbidden (would create false-positive readiness). The disposable probe is **caller-site only** (e.g., a `tui-command.ts` preflight); `createKoiRuntime` does not consume a probe factory and never probes local-bridge transports itself.

### Future server change (out of scope)

If the Nexus server adds a dedicated `health` or `ready` RPC that aggregates all subsystem checks (incl. audit/fs storage), `health()` switches to that single call. Until then, the documented control-plane-only contract is the honest one.

## Startup integration (telemetry by default, opt-in assert-transport-reachable-at-boot / assert-remote-policy-loaded-at-boot)

The real production boundary is `packages/meta/cli/src/runtime-factory.ts:832` (`KoiRuntimeFactoryConfig.nexusTransport`). The runtime factory wires Nexus into `createNexusPermissionBackend` and `createNexusAuditSink`.

**Critical existing contract: local-first permissions.** `createNexusPermissionBackend` is documented as "local-first: TUI rules apply when Nexus has no policy or is unreachable." A golden test in `meta/runtime/src/__tests__/golden-replay.test.ts` proves this fallback. **A fail-closed startup gate would break this contract** and convert recoverable Nexus outages into total runtime unavailability. That is a regression.

**Decision: telemetry-by-default for everything; assert-transport-reachable-at-boot and assert-remote-policy-loaded-at-boot are explicit opt-ins.**

Earlier drafts proposed making audit-wired runtimes default to `assert-transport-reachable-at-boot`. That was wrong: `health()` does NOT probe the audit write path (no non-side-effecting audit RPC exists today), so defaulting to fail-closed for audit gives a **false safety signal**. Better to be honest: telemetry default for everything, document the audit-write gap, and let operators opt in.

| Mode | Behavior |
|---|---|
| `telemetry` (default) | log on transport failure; log activation status; continue boot |
| `assert-transport-reachable-at-boot` | throw on transport failure OR on `notFound: true` for either default probe path (`version.json` / `policy.json`) — missing policy namespace is fatal, not healths (version + version.json read + policy.json read); does NOT validate that policy files exist or that backend successfully activates remote policy |
| `assert-remote-policy-loaded-at-boot` | throw on transport failure; throw on first-sync policy-activation failure (awaits `backend.ready`). **STARTUP GATE ONLY, REMOTE-LOAD ONLY** — proves remote policy was loaded at boot. Does NOT prove remote policy will be enforced for every check: per existing composition (`runtime-factory.ts:1797-1806`), Nexus backend chains to local TUI on `ask`/no-opinion results, so queries not matched by remote policy still execute under local rules. Does NOT enforce ongoing freshness either: last-known-good remote policy continues to be served after sync failures. Operators needing strict centralized enforcement (no local fallback for unmatched queries) need a permission-composition change tracked separately. |

**⚠️ Security caveat — no mode in this PR provides centralized-policy enforcement.** `assert-transport-reachable-at-boot` only proves the transport can carry read calls. `assert-remote-policy-loaded-at-boot` only proves remote policy was loaded at boot. Neither prevents local-rule fallback for queries the remote policy doesn't match (existing permission composition chains to local TUI on `ask`/no-opinion). The mode names deliberately reflect what they actually gate (`-transport`, `-remote-policy-loaded`) rather than implying enforcement they don't deliver. **Operators requiring strict centralized enforcement (no local fallback for unmatched queries) must wait for the permission-composition change tracked separately** — neither mode here is sufficient for that requirement.

**Policy-activation check** (only in `assert-remote-policy-loaded-at-boot`):

After the permission backend is created, the runtime `await`s `nexusPermBackend.ready` and inspects whether centralized policy actually activated (vs. fell back to local). The backend exposes activation status via its existing `ready` promise resolution and a documented status field. If activation failed (file 404, parse error, `rebuildBackend` shape mismatch, `supportsDefaultDenyMarker` mismatch), the runtime throws before exposing the runtime to requests. This closes the race the earlier draft had: requests cannot be served against the local fallback when policy-required mode is set.

**Audit-write runtime error surfacing (opt-in, in scope this PR):**

`@koi/middleware-audit` already exposes an `onError` hook, and `runtime-factory.ts` already wires NDJSON and SQLite sinks through a poison-on-error guard pattern (`runtime-factory.ts:2526–2602`). The Nexus audit sink is currently wired without that pattern, so Nexus audit silently drops records on flush failure.

**Critical: the poison-guard pattern is fail-stop on first failure.** Wiring it unconditionally would turn the default `telemetry` boot mode into fail-stop on the first Nexus audit hiccup — a behavior regression. Therefore the guard is **opt-in via a separate config flag**, orthogonal to `nexusBootMode`:

```ts
interface KoiRuntimeFactoryConfig {
  // …
  /**
   * **POST-FAILURE CONTAINMENT — NOT A COMPLIANCE-ENFORCEMENT CONTROL.**
   * Do NOT enable this flag to satisfy a compliance requirement that every
   * audited operation MUST persist before the operation completes. The
   * Nexus audit sink is asynchronous and remote; this flag cannot make it
   * synchronous-fail-stop. It is named "poison" not "fail-stop" for that
   * reason.
   *
   * What this flag actually does when true:
   *   - Latches `nexusPoison.err` on the first sink failure.
   *   - Rejects subsequent `sink.log()` calls at the wrapper (post-poison
   *     records surface as observable failures).
   *   - Denies admission at the NEXT middleware boundary
   *     (`onSessionStart`/`onBeforeTurn`/`wrapModelCall`/`wrapToolCall`/
   *     `onSessionEnd`).
   *
   * What this flag does NOT do:
   *   - It does NOT abort an in-flight tool/model call when the audit
   *     sink fails. Operations that have already crossed an admission
   *     boundary RUN TO COMPLETION — including any side effects.
   *   - It does NOT guarantee the triggering record was persisted (the
   *     background/size-triggered flush may already have lost it).
   *   - It does NOT call `process.exit(1)` (Nexus is remote; async hard
   *     exit on remote failure would strand mid-session work — see
   *     out-of-scope: coordinated runtime shutdown API).
   *   - It does NOT match the synchronous flush+rethrow per boundary that
   *     NDJSON/SQLite required-sinks perform (remote round-trip per
   *     boundary would wedge the agent loop).
   *
   * Operators who require per-operation synchronous fail-stop MUST use a
   * required local sink (NDJSON or SQLite with `required: true`); the
   * Nexus poison mode is for operators who want eventual containment of
   * NEW work after a known sink failure without paying remote-round-trip
   * cost on every loop iteration. Use this when "stop accepting new work
   * once Nexus audit breaks" is good enough. Do NOT use this when
   * "guarantee no operation completes without an audit record" is required.
   *
   * Default: false (best-effort, matches current Nexus audit behavior).
   * Independent of nexusBootMode — boot-mode controls the startup probe;
   * this controls runtime audit error semantics.
   */
  readonly nexusAuditPoisonOnError?: boolean | undefined;
}
```

When `nexusAuditPoisonOnError === true`, the runtime hooks Nexus sink errors into a **per-sink poison latch** that is checked at every admission boundary. The per-sink latch + admission gate is the SAME machinery NDJSON/SQLite use, BUT the Nexus guarantee is intentionally **weaker than required-NDJSON/SQLite** in one important way (documented honestly here so operators do not over-trust the mode).

**Honest scoping — Nexus guarantee is POST-FAILURE CONTAINMENT, not synchronous-flush parity:**

The pre-PR NDJSON/SQLite required-sink middleware does a **synchronous `flush()` + rethrow at every boundary** (onSessionStart, onSessionEnd, onPermissionDecision, wrapModelCall, wrapToolCall) so any flush error surfaces BEFORE the next side-effecting operation runs. That is achievable because both sinks are local-disk: a flush is a syscall, costs microseconds, and never blocks.

Nexus is REMOTE and BUFFERED. A synchronous flush at every boundary would require a Nexus round-trip (10-200ms typically, can be seconds under degraded conditions) before every model call and tool call — wedging the agent loop. The Nexus poison mode therefore drops the synchronous-flush+rethrow part of the NDJSON/SQLite contract and ships ONLY the per-sink latch + admission-gate-at-next-boundary half:

| Sink | Latch on error | Admission gate denies on latch | Synchronous flush+rethrow per boundary |
|---|---|---|---|
| NDJSON `required:true` | yes | yes | **yes** (local-disk, microsecond cost) |
| SQLite `required:true` | yes | yes | **yes** (same) |
| Nexus `poisonOnError:true` | yes | yes | **no** (remote round-trip would wedge the agent loop) |

**Containment semantics this PR actually delivers (Nexus opt-in mode):**

- The first failed Nexus write LATCHES `nexusPoison`.
- The poisoned-sink wrapper REJECTS every subsequent `log()` so post-poison writes surface as observable failures (compliance recorder's `onError` fires).
- The audit-middleware admission gate REFUSES new work at the NEXT boundary — but a side-effecting operation that is already in flight when Nexus first fails will COMPLETE before the gate fires.

That is materially weaker than the local-sink contract. It is still meaningfully better than the pre-PR silent-drop default. Operators who need every audited operation to fail-stop synchronously on first remote-write failure are NOT served by this mode and should require a local sink (NDJSON or SQLite with `required:true`); the Nexus poison mode is for operators who want eventual fail-stop containment without paying remote round-trip cost on every loop iteration.

**Per-sink state, per-sink admission boundary checks (machinery):**

- Each sink gets its own poison latch (`ndjsonPoison`, `sqlitePoison`, `nexusPoison`).
- Each required-sink latch is checked at every admission boundary (`onSessionStart`, `onBeforeTurn`, `wrapModelCall`, `wrapToolCall`, end-of-session flush). ANY poisoned required latch denies admission. NDJSON/SQLite admission denial is paired with synchronous flush+rethrow at the boundary; Nexus admission denial is NOT (see scoping above).
- Optional sinks (e.g., NDJSON without `required: true`; Nexus with `nexusAuditPoisonOnError !== true`) log on failure but never block admission.

**Two-layer containment mechanics (Nexus opt-in mode):**

1. **Sink-side short-circuit (poisoned `log()` wrapper).** When `nexusAuditPoisonOnError === true`, the runtime wraps `createNexusAuditSink(...)` in a thin `poisonedSink(inner, latch)` adapter that, on every `log()` call, FIRST inspects the latch:

   - latch unset → delegates to the inner sink's `log()` as normal
   - latch set → REJECTS the call with the latched error (returns a rejected `Promise<Result<void, KoiError>>` carrying `code: "AUDIT_SINK_POISONED"` and `cause: latch.err`). Increments a `dropped` counter exposed in telemetry. **Does NOT silently resolve** — silent resolution would defeat the fail-stop contract: `createAuditSinkComplianceRecorder` only fires its `onError` when `sink.log()` rejects, so a no-op success would let post-poison compliance events disappear with no observable signal. Rejecting matches the existing NDJSON/SQLite poison-wrapper behavior at `runtime-factory.ts:2526-2602` exactly.

   This closes the post-poison drop window the reviewer flagged: without the wrapper, the Nexus sink's internal buffer would keep accepting `log()` calls between latch-set and the next admission boundary, losing records the operator declared must be durable. The wrapper mirrors the existing NDJSON/SQLite poisoned-sink pattern (`runtime-factory.ts:2526-2602` already wraps those sinks the same way; the Nexus wiring extends that pattern with no behavior divergence).

2. **Middleware admission gate.** Per-sink admission check at every boundary (the `admissionAllowed()` helper sketched below). This is the existing NDJSON/SQLite gate; Nexus joins it via the per-sink latch. The gate fails the work item that crosses the boundary AFTER the wrapper has already stopped accepting writes.

**Spec contract (Nexus post-failure containment — explicitly NOT NDJSON/SQLite parity):** once `nexusPoison.err` is set, (a) every subsequent `log()` is REJECTED at the sink wrapper (no internal buffering can absorb more records than the latch is aware of), AND (b) the NEXT admission boundary refuses work. The latch and gate are the same primitives NDJSON/SQLite use, but the synchronous flush+rethrow that NDJSON/SQLite perform AT EACH BOUNDARY is intentionally omitted for Nexus (would require a remote round-trip per boundary — agent loop wedge). This means a side-effecting operation in flight when the first Nexus write fails will complete; the gate fires only at the next boundary check. Both wrapper and gate are required for the containment guarantee documented above.

**Implementation home:** the `poisonedSink` wrapper lives in `runtime-factory.ts` next to the existing NDJSON/SQLite wrapper code (no new package). It is sink-kind-agnostic — same closure shape works for all three sinks, only the latch object differs.

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
  const inner = createNexusAuditSink({ transport: config.nexusTransport, onError });
  // poisonedSink wrapper: short-circuits log() once the latch is set so
  // post-poison records are dropped at the sink boundary instead of being
  // accepted into the inner buffer (matches NDJSON/SQLite wrapper pattern
  // already at runtime-factory.ts:2526-2602). When nexusAuditPoisonOnError
  // is false, the latch is never set, so the wrapper is a no-op pass-through.
  auditSinks.push(poisonedSink(inner, nexusPoison));
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

**Honest semantics — fail-stop at admission boundaries, observability at log boundaries. NOT durability for the triggering record:**

Background flush failure → `onError` fires → per-sink latch set → operator sees error log immediately. Next admission boundary (`onSessionStart`/`onBeforeTurn`/`wrapModelCall`/`wrapToolCall`) inspects the latch and refuses. **The triggering record (the operation whose audit write failed) is NOT protected — it has already completed and its audit may be lost.** What `nexusAuditPoisonOnError` provides is "no SUBSEQUENT work proceeds past a known-failed sink," matching NDJSON/SQLite exactly.

Operators needing per-record durability (the audited operation must not return until its record is persisted) need a synchronous-write architecture, which Nexus today does not support. This PR does NOT advertise per-record durability and explicitly documents the gap. **Position `nexusAuditPoisonOnError` as POST-FAILURE CONTAINMENT (no further work after a known-failed sink), NOT compliance/forensic durability.** The mode name and docs intentionally avoid "durability" / "compliance" language for that reason.

**The previous `createPoisonGuardedNexusAuditSink` helper is dropped** — runtime-factory hooks the existing pattern directly. Less code, no duplicate guard surface, no risk of helper-vs-runtime divergence.

**Default (telemetry mode, `nexusAuditPoisonOnError` unset):** Nexus audit remains best-effort. Failures are logged via `onError` but do not abort writes or rethrow at flush. Same observable behavior as today.

**Opt-in (`nexusAuditPoisonOnError: true`):** Full guard model — first failure latches, subsequent `log()` calls throw, every middleware flush boundary rethrows. Matches NDJSON/SQLite semantics. Compatible with any `nexusBootMode`.

**Compliance-recorder coverage (in scope this PR):**

The Nexus audit sink is wired into TWO middleware paths in `runtime-factory.ts`:

1. **Audit middleware sink** (`createAuditMiddleware({ sink: nexusSink })`) — failures here flow through `nexus-sink`'s `onError` config and (when opted in) the shared `auditPoisonError` accumulator described above.
2. **Compliance recorder** (`createAuditSinkComplianceRecorder(nexusSink, { sessionId, onError })`) at `runtime-factory.ts:3058-3059` — this is a SEPARATE write path with its own failure policy. NDJSON and SQLite compliance recorders use `onError: process.exit(1)` today (synchronous termination — local writes are filesystem-bound, fail-stop is acceptable).

**Important divergence from NDJSON/SQLite:** Nexus is a REMOTE dependency. A transient Nexus write failure delivered asynchronously through `sink.log(...).catch(onError)` would, under a naïve `process.exit(1)` mirror, abruptly terminate the CLI mid-session AFTER user-visible work has already executed and WITHOUT cleanup of channels, MCP servers, in-flight tool calls, or pending audit flushes for the local sinks. That is worse than fail-stop — it is uncontrolled abort. The current Nexus compliance recorder is wired with NO `onError` callback, defaulting to silent (the bug this PR fixes).

**Scoping decision (Loop 4 R3):** the runtime today exposes only `shutdownBackgroundTasks()` (synchronous, fire-and-forget); there is no coordinated `requestShutdown` capability that could stop admissions, flush local sinks, close transports, and exit cleanly. Designing one is a separate prerequisite. Rather than specify a mitigation that the implementation cannot honor, this PR scopes Nexus compliance-recorder failure handling to **per-sink poison latch + admission gate**. No direct `process.exit(1)` is wired for Nexus. A coordinated-shutdown follow-up issue is tracked under "Out of scope" below.

This PR brings Nexus compliance-recorder failure handling to fail-stop-at-admission-boundary semantics — but only when the operator opts in. Three modes:

| `nexusAuditPoisonOnError` | Audit middleware sink | Compliance recorder |
|---|---|---|
| `false` (default) | best-effort log | best-effort log (NEW: was silent) |
| `true` | per-sink poison latch + admission deny (joins NDJSON/SQLite per-sink fail-stop) | latch `nexusPoison` + admission gate refuses new work at next boundary (NO `process.exit(1)`, NO synthetic shutdown signal) |

Concretely in `runtime-factory.ts`:

```ts
complianceRecorders.push(
  createAuditSinkComplianceRecorder(nexusSinkForCompliance, {  // SAME wrapped instance as auditSinks.push above — never the bare inner sink
    sessionId: getLiveSessionId,
    onError: config.nexusAuditPoisonOnError === true
      ? (error) => {
          // Latch first — admission gate stops accepting new work at the
          // next boundary. No process.exit() and no fictitious shutdown
          // primitive: the runtime simply stops admitting and the in-flight
          // session unwinds normally on its next iteration. The poisoned-
          // sink wrapper (above) also rejects further sink.log() calls so
          // post-poison compliance writes surface as observable failures.
          if (nexusPoison.err === undefined) nexusPoison.err = error;
          logger.error({ err: error }, "nexus compliance sink write failed — admission gate latched");
        }
      : (error) => logger.warn({ err: error }, "nexus compliance sink write failed (best-effort)"),
  }),
);
```

**Honest containment guarantee (this PR):** in `nexusAuditPoisonOnError: true` mode, after the first compliance failure: (a) the poisoned-sink wrapper rejects every subsequent `sink.log()` with `code: "AUDIT_SINK_POISONED"` so post-poison compliance writes are not silently dropped, AND (b) the audit-middleware admission gate denies new work at the next boundary. No new tool calls or model calls execute under a known-bad audit path. The current session's already-admitted work continues to natural completion; cleanup runs normally on session end. No mid-session abort.

**What this PR explicitly does NOT promise:** synchronous termination after first compliance failure. Operators who require a hard exit on remote-compliance failure (e.g., regulated-environment CLI wrappers) need the coordinated-shutdown follow-up — not in scope here. Without it, between the latch firing and end-of-session, work that was already admitted will run to completion. The admission gate and the poisoned-sink wrapper are the only fail-stop primitives this PR ships.

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

type NexusBootMode = "telemetry" | "assert-transport-reachable-at-boot" | "assert-remote-policy-loaded-at-boot";

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
  // (REMOVED Loop 3 Round 1: nexusProbeFactory. The runtime probes HTTP in
  //  place; local-bridge wires no Nexus consumer in this PR, so the factory
  //  had no caller. The disposable-probe constructor `createLocalBridgeProbeTransport`
  //  remains exported for callers wanting standalone probe runs at the call
  //  site, but the runtime config field is gone — eliminates the dead safety
  //  switch operators could mistakenly rely on.)
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
   * **Phase 1 (this PR):** unset → on HTTP, INFER `true` + deprecation warning;
   *   on local-bridge, THROWS at boot (no inference; fs-only sessions must use
   *   the tui-command.ts decoupling and not pass `nexusTransport`).
   * **Phase 2 (next release):** unset throws on all transports.
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
   * **Phase 1 (this PR):** unset → on HTTP, INFER `true` + one-time deprecation
   *   warning (preserves existing healthy HTTP deployments); on local-bridge,
   *   THROWS at boot (no inference — fs-only sessions must use the
   *   tui-command.ts decoupling and not pass `nexusTransport`).
   * **Phase 2 (next release):** unset throws on all transports.
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
   * - "assert-transport-reachable-at-boot": **DIAGNOSTIC ONLY — not a security
   *   control.** Throws on transport failure or 404 on default probe path
   *   (version.json / policy.json — namespace absent is fatal). **Requires
   *   `nexusPermissionsEnabled=true`**: today's probe is a `version` call plus
   *   a permission-namespace read; with permissions disabled the gate
   *   collapses to `version` only and would silently pass even when audit
   *   credentials are read-only or audit ACLs are missing. Audit-only
   *   fail-fast is therefore unsupported — operators must use telemetry mode
   *   until a non-side-effecting audit-write probe exists on the Nexus
   *   server. **Does NOT prevent pre-sync authorization against local TUI
   *   fallback** — early requests can be served by local rules before first
   *   remote-policy activation, so this mode is unsuitable for compliance/
   *   security deployments that require pre-sync centralized enforcement.
   *   Use `assert-remote-policy-loaded-at-boot` (which awaits first sync) for
   *   deployments that must not authorize before remote policy is loaded —
   *   even that mode does NOT prevent local-rule fallback for queries the
   *   remote policy doesn't cover. See security caveat in design doc.
   * - "assert-remote-policy-loaded-at-boot": throw on transport failure OR
   *   first-sync policy-load failure (awaits backend.ready and inspects
   *   isCentralizedPolicyActive()). STARTUP GATE, REMOTE-LOAD ONLY — proves
   *   remote policy was loaded at boot. **Requires `nexusPermissionsEnabled=true`**:
   *   the runtime throws at config validation if this mode is selected
   *   without the permissions backend wired (no `ready` to await, no
   *   `isCentralizedPolicyActive()` to call). Audit-only deployments have
   *   NO supported startup-gate mode — they must use "telemetry" until a
   *   non-side-effecting audit-write readiness probe exists on the Nexus
   *   server (see assert-transport-reachable-at-boot for the same
   *   audit-only rejection rationale). Does NOT prevent local-rule fallback
   *   for queries not matched by remote policy
   *   (existing composition chains to local TUI on ask/no-opinion). Does NOT
   *   enforce ongoing freshness.
   */
  readonly nexusBootMode?: NexusBootMode | undefined;
  /**
   * Bound on the `await nexusPermBackend.ready` step in
   * `assert-remote-policy-loaded-at-boot` mode. The backend's internal
   * first-sync `read` calls inherit the transport DEFAULT deadline (45s
   * for HTTP), which would let a "fail-fast" assert mode hang the CLI
   * tens of seconds against a slow Nexus. The runtime races the ready
   * promise against this deadline; on timeout, boot throws with an
   * actionable message. Default: 10_000ms (HEALTH_DEADLINE_MS=5s probe +
   * one read RTT round-trip budget for the backend's first sync).
   * Operators on legitimately slow Nexus deployments can raise this; in
   * telemetry / assert-transport-reachable-at-boot modes the field is
   * unused (no first-sync await runs).
   */
  readonly nexusBootSyncDeadlineMs?: number | undefined;
}

const NEXUS_BOOT_SYNC_DEADLINE_MS_DEFAULT = 10_000;

export async function createKoiRuntime(config: KoiRuntimeFactoryConfig) {
  // … existing setup …

  // Step 0: RESOLVE consumer flags BEFORE any gate fires. All subsequent
  // checks (probe-factory required, security gates, audit-mode required)
  // run against `permsEnabled`/`auditEnabled`/`txKind`, never the raw
  // optional config fields. This guarantees inferred-true cannot bypass
  // a gate that explicit-true would trip. See Phase 1/Phase 2 rules below.
  //
  // RESOLUTION RULES (single behavior — no oscillation):
  //   - HTTP transport, unset perms/audit → infer TRUE + warn (Phase 1
  //     deprecation; Phase 2 throws). Preserves existing v2 HTTP boots.
  //   - local-bridge transport, unset perms OR unset audit → THROW. No
  //     inference path. Architecturally backed by `tui-command.ts`
  //     decoupling: it does NOT pass `nexusTransport` into `createKoiRuntime`
  //     for fs-only sessions, so any caller that reaches this branch with
  //     local-bridge has intentionally opted in. Throwing forces the
  //     explicit decision — silent disablement of a security control is
  //     not an option. Programmatic callers that miss the migration get a
  //     hard, actionable error instead of a quiet authorization downgrade.
  // KIND ASSERTION ORDERING: assertProductionTransport runs ONLY after the
  // explicit fs-only opt-out is checked. Pre-PR semantics implicitly wired
  // both Nexus consumers when nexusTransport was supplied, so the safe
  // upgrade path for legacy structural adapters is:
  //
  //   "construct via named factory" → kind set, no throw
  //   OR
  //   "set both nexusPermissionsEnabled=false AND nexusAuditEnabled=false"
  //   → fs-only opt-out, kind assertion SKIPPED (legacy adapter keeps
  //     working for non-Nexus subsystems without being rewritten)
  //
  // If we asserted kind first, the documented opt-out would be impossible
  // to reach for legacy callers — they'd throw before flag resolution and
  // the rollout would be a hard outage instead of a documented migration.
  const explicitlyOptedOut =
    config.nexusPermissionsEnabled === false
    && config.nexusAuditEnabled === false;
  let txKind: NexusTransportKind | undefined;
  if (config.nexusTransport === undefined || explicitlyOptedOut) {
    txKind = undefined;  // skip Nexus block entirely
  } else {
    // Any other path requires a discriminated transport. Throws with the
    // factory + opt-out migration message when kind is missing.
    txKind = assertProductionTransport(config.nexusTransport).kind;
  }
  // POST-ASSERT INVARIANT: txKind is "http" | "local-bridge" | undefined,
  // where undefined means EITHER no transport was supplied OR the operator
  // explicitly opted out of both Nexus consumers. Either way, no Nexus
  // startup work runs below.
  //
  // (No raw-kind peek needed — the assert-* preflight below uses
  // assertProductionTransport for positive identification, which subsumes
  // both the local-bridge reject and the missing-kind reject.)
  if (txKind === "local-bridge") {
    const missing: string[] = [];
    if (config.nexusPermissionsEnabled === undefined) missing.push("nexusPermissionsEnabled");
    if (config.nexusAuditEnabled === undefined) missing.push("nexusAuditEnabled");
    if (missing.length > 0) {
      throw new Error(
        `nexusTransport.kind="local-bridge" requires explicit ${missing.join(" and ")}. ` +
        "Silent inference would either disable a security control (false) or " +
        "wire an unsupported path (true). Set explicitly: Nexus permissions " +
        "on local-bridge is unsupported (use HTTP); Nexus audit on local-bridge " +
        "requires nexusAuditMode and skips the Nexus sink. " +
        "If this is a fs-only session, do NOT pass nexusTransport into " +
        "createKoiRuntime (see tui-command.ts decoupling).",
      );
    }
  }
  const permsEnabled = config.nexusPermissionsEnabled
    ?? (txKind === "http" ? true : undefined);
  const auditEnabled = config.nexusAuditEnabled
    ?? (txKind === "http" ? true : undefined);
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
  if (txKind === "http") {
    const inferences: string[] = [];
    if (config.nexusPermissionsEnabled === undefined) inferences.push("nexusPermissionsEnabled→true");
    if (config.nexusAuditEnabled === undefined) inferences.push("nexusAuditEnabled→true");
    if (inferences.length > 0) {
      logger.warn({ inferences, txKind: "http" },
        "DEPRECATED: nexusTransport set with implicit consumer flags. " +
        `Set explicitly: ${inferences.join(", ")}. Phase 2 will throw on unset.`);
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
  // BOOT-MODE PREFLIGHT: validated UNCONDITIONALLY (not gated on
  // anyEffectiveConsumer) so an operator who declares assert-* on a
  // local-bridge transport gets a loud failure even when the consumer
  // resolution would otherwise short-circuit the probe block.
  // Without this hoist, `local-bridge + nexusAuditMode="local-only"` (which
  // resolves effectiveAuditWired=false) silently accepts assert-* and boots
  // with no probe — exactly the misconfiguration this gate exists to catch.
  const declaredBootMode: NexusBootMode =
    config.nexusBootMode ?? "telemetry";
  // POSITIVE-IDENTIFICATION GATE for assert-* boot modes.
  // assert-* is HTTP-only. Validating the rejection by `kind === "local-bridge"`
  // alone would let two unsafe configurations slip through:
  //   (a) legacy local-bridge adapter without `kind` set + explicit fs-only
  //       opt-out (both flags false): kind peek returns undefined, so the
  //       local-bridge-specific reject doesn't fire.
  //   (b) any structurally-shaped transport that lacks `kind`: same.
  // Both end up booting with no probe under a mode the operator believed
  // would fail-fast. Flip the gate to require POSITIVE identification of
  // HTTP — anything else throws.
  // assert-* preflight ONLY when the operator hasn't explicitly opted out
  // of all Nexus consumers. Without the opt-out check, a caller who follows
  // the documented fs-only migration (perms=false + audit=false) but leaves
  // a stale KOI_NEXUS_BOOT_MODE=assert-* in their environment would still
  // hard-fail boot — turning the opt-out into a hidden tripwire. Once both
  // consumers are explicitly disabled, ALL Nexus boot validation is inert:
  // no probe, no consumer wiring, no boot-mode preflight, no kind assertion.
  // This is the rollback contract: a caller can disable Nexus by setting
  // both flags false WITHOUT having to scrub every Nexus env/CLI input.
  if (
    !explicitlyOptedOut
    && config.nexusTransport !== undefined
    && declaredBootMode !== "telemetry"
  ) {
    // assertProductionTransport throws on missing kind (and that error message
    // already names the named factories + opt-out). When kind IS set but is
    // local-bridge, throw the local-bridge-specific message instead.
    const positiveKind = assertProductionTransport(config.nexusTransport).kind;
    if (positiveKind !== "http") {
      throw new Error(
        `nexusBootMode=${declaredBootMode} requires a positively-identified HTTP transport ` +
        `(got kind=${JSON.stringify(positiveKind)}). assert-* is unsupported on ` +
        `local-bridge in any configuration — local-bridge cannot be probed without ` +
        `risking session wedge on auth challenges, and probing a disposable ` +
        `subprocess would not validate the live session, so the fail-closed-* ` +
        `guarantee would be misleading. Use HTTP transport or nexusBootMode="telemetry".`,
      );
    }
  }
  // (Operators who set assert-* AND opted out get a one-time warning so the
  // misconfiguration is visible without breaking boot — opt-out wins, but
  // the dead config is not silent.)
  if (explicitlyOptedOut && declaredBootMode !== "telemetry") {
    logger.warn({ declaredBootMode },
      "nexusBootMode is set but ignored: explicit opt-out (nexusPermissionsEnabled=false + nexusAuditEnabled=false) skips all Nexus boot validation. Remove KOI_NEXUS_BOOT_MODE / --nexus-boot-mode to clear this warning.");
  }
  // (rawKindForBootValidation is no longer needed — the positive-identification
  // gate above subsumes the raw-kind peek and closes the missing-kind bypass.)

  // Probe + Nexus consumer wiring is GATED on resolved consumer flags.
  // A filesystem-only Nexus transport (both consumers explicitly false, OR
  // local-bridge no-flags inferred-false) skips ALL Nexus startup probing
  // and consumer wiring — the transport is used elsewhere (fs reads etc.)
  // and is none of this block's concern.
  //
  // POST-ROUND-10 OBSERVATION: `effectivePermsWired` and `effectiveAuditWired`
  // both require `txKind === "http"`, so `anyEffectiveConsumer === true`
  // implies HTTP transport here. Local-bridge never enters this block — its
  // observability-only probe support is INTENTIONALLY DROPPED in this PR.
  // Operators who want a local-bridge spawn-config validation probe can run
  // it separately at the call site (e.g., `tui-command.ts`) before calling
  // `createKoiRuntime`. The runtime contract is HTTP-only for Nexus
  // consumer probing — single source of truth, no dead branches.
  if (txKind !== undefined && anyEffectiveConsumer) {
    const mode: NexusBootMode = config.nexusBootMode ?? "telemetry";
    const policyBase = config.nexusPolicyPath ?? "koi/permissions";

    // Step 1: probe transport health (HTTP only).
    //
    // RUNTIME PROBE CONTRACT: this block probes ONLY HTTP transports. The
    // `anyEffectiveConsumer` gate above guarantees txKind === "http" by the
    // time we reach here (every effective consumer requires HTTP). Local-bridge
    // transports never reach the probe path inside the runtime; spawn-config
    // validation for local-bridge is a caller-site responsibility (see
    // `createLocalBridgeProbeTransport` exported from fs-nexus).
    //
    // (Local-bridge + assert-* preflight runs unconditionally above, before
    // the anyEffectiveConsumer gate, so we don't repeat it here.)
    // BOTH assert-* modes require the permissions consumer to be wired:
    //
    //  - assert-remote-policy-loaded-at-boot awaits backend.ready and checks
    //    isCentralizedPolicyActive(); without a permissions backend there is
    //    nothing to await.
    //
    //  - assert-transport-reachable-at-boot is also rejected for audit-only
    //    deployments, because the probe today is a `version` call plus a
    //    permission-namespace read. With permissions disabled the probe
    //    collapses to `version`, which does NOT exercise the audit write
    //    path. Offering it as an audit-only "fail-fast" gate would be a
    //    false-negative — read-only credentials, missing audit namespace/ACLs,
    //    or write-path failures all pass `version` and surface only on the
    //    first real audit write. Until the Nexus server exposes a
    //    non-side-effecting audit-write readiness probe, audit-only fail-fast
    //    is unsupported. Operators wanting audit-only must use telemetry mode.
    if (!effectivePermsWired && mode !== "telemetry") {
      const reason = mode === "assert-remote-policy-loaded-at-boot"
        ? `awaits the permissions backend's first sync; without permissions wired there is no policy to load.`
        : `the probe collapses to a 'version' call, which does NOT exercise the audit write path. Read-only credentials, missing audit namespace/ACLs, and write-path failures would all pass boot and surface only on first audit write — a false-negative gate.`;
      throw new Error(
        `nexusBootMode="${mode}" requires nexusPermissionsEnabled=true: ${reason} ` +
        `Audit-only deployments must use nexusBootMode="telemetry" until a ` +
        `non-side-effecting audit-write readiness probe exists on the Nexus server.`,
      );
    }

    // Pick probe transport: HTTP only.
    // The session itself satisfies HealthCapable; probe in place.
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
    }
    // (No local-bridge branch here — `anyEffectiveConsumer` gate above
    // guarantees txKind === "http" at this point. Local-bridge probing is
    // a separate caller-site responsibility, not a runtime-factory concern.)

    // Probe path selection: read permission-policy paths only when permissions
    // are wired. With both assert-* modes now requiring permissions wired (see
    // the rejection above), the empty-readPaths branch only applies in
    // telemetry mode + audit-only deployments — purely advisory probe activity
    // with no boot-blocking effect, so a 404 on the (skipped) policy paths
    // can't strand audit-only operators.
    const probePolicyPaths = effectivePermsWired
      ? [`${policyBase}/version.json`, `${policyBase}/policy.json`]
      : [];
    let health;
    if (probeTransport !== undefined) {
      try {
        health = await probeTransport.health({ readPaths: probePolicyPaths });
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
        logger.warn({ err: health.error, probeKind: txKind }, msg);
      } else {
        throw new Error(msg, { cause: health.error });  // assert-* throws
      }
    } else if (health !== undefined && health.value.status === "missing-paths") {
      // status="missing-paths" means the policy NAMESPACE is missing — not
      // a transport failure, but an absent control surface. Telemetry logs
      // and continues; assert-transport-reachable-at-boot and
      // assert-remote-policy-loaded-at-boot BOTH refuse to boot (the
      // operator declared they want remote policy present at startup; an
      // absent namespace contradicts that). The status discriminator forces
      // us to handle this case explicitly — no boolean check could miss it.
      const missing = health.value.notFound.join(", ");
      const msg = `Nexus probe found missing policy paths: ${missing} (namespace absent)`;
      if (mode === "telemetry") {
        logger.warn({ notFound: health.value.notFound, probeKind: txKind }, msg);
      } else {
        throw new Error(msg);  // both assert-* modes
      }
    } else if (
      health !== undefined
      && (health.value.status === "ok" || health.value.status === "version-only")
    ) {
      // Probe success log — but ALWAYS surface the audit-readiness gap.
      // The probe validates `version` (transport reachability) and policy
      // reads (when permissions are wired). It NEVER validates the audit
      // write path — there is no non-side-effecting audit-readiness RPC
      // today (documented under "Out of scope"). Three honest variants:
      //
      //   - permissions wired + audit wired: policy reads succeeded BUT
      //     audit-write readiness UNVALIDATED — log includes the marker so
      //     dashboards / operators don't mistake this for fully-validated
      //     audit health. The session can still fail asynchronously on the
      //     first audit flush.
      //   - permissions wired + audit NOT wired: policy reads succeeded;
      //     audit not in scope for this deployment. Plain "ok".
      //   - permissions NOT wired + audit wired: only `version` was probed
      //     (no policy reads, no audit probe) — log as PARTIAL with WARN.
      //   - permissions NOT wired + audit NOT wired: this branch unreachable
      //     because anyEffectiveConsumer would be false.
      const auditWired = effectiveAuditWired;
      const versionOnlyAuditOnly = !effectivePermsWired;
      const probeScope = txKind === "local-bridge"
        ? "spawn-config-validated (disposable probe; live session NOT validated)"
        : versionOnlyAuditOnly
          ? "version-only (audit write path NOT validated — no audit-readiness probe exists)"
          : auditWired
            ? "session-validated-with-policy-reads (audit-write readiness UNVALIDATED — no audit-readiness probe exists)"
            : "session-validated";
      const msg = versionOnlyAuditOnly
        ? "nexus probe partial: version reachable, audit-write readiness UNVALIDATED"
        : auditWired
          ? "nexus probe ok (with caveat): policy reads succeeded; audit-write readiness UNVALIDATED — failures will surface on first audit flush"
          : "nexus probe ok: session-validated";
      // logger.warn for the audit-only partial AND for the perms+audit
      // path so audit-unvalidated is impossible to filter out as routine
      // info. Only the perms-wired-without-audit path uses INFO.
      const logFn = (versionOnlyAuditOnly || auditWired)
        ? logger.warn.bind(logger)
        : logger.info.bind(logger);
      logFn({
        latencyMs: health.value.latencyMs,
        version: health.value.version,
        probed: health.value.probed,
        probeScope,
        partial: versionOnlyAuditOnly,
        auditUnvalidated: auditWired || versionOnlyAuditOnly,
      }, msg);
    }
    // health === undefined → probe skipped (already logged above)
  }

  // Step 3: wire nexus consumers. Wiring is gated by transport-kind:
  //   - HTTP: full Nexus permissions + audit support, all boot modes available.
  //   - local-bridge: permissions REJECTED categorically (early-request
  //     centralized-policy bypass — see hard-reject below). Audit gated by
  //     nexusAuditMode (Round 5+ contract).
  // Telemetry-mode HTTP probe failure is advisory — wiring still proceeds.
  // All Nexus consumer-wiring blocks below additionally require txKind!==undefined.
  // Phase 1 missing-kind transports skip everything Nexus-related (matches the
  // "treat as fs-only" rollout rule documented on assertProductionTransport).
  let nexusPermBackend;
  if (txKind !== undefined && permsEnabled === true) {
    // (REMOVED in Round 10: deferInitialSync + triggerImmediateSync mitigations.
    //  Their sole purpose was to soften the local-bridge auth-wedge during first
    //  policy sync; with local-bridge + permissions now categorically rejected,
    //  these mitigations are dead code. HTTP path uses immediate constructor-time
    //  sync exactly as before this PR.)
    nexusPermBackend = createNexusPermissionBackend({
      transport: config.nexusTransport,
      policyPath: config.nexusPolicyPath ?? "koi/permissions",  // existing backend field name
      syncIntervalMs: config.nexusSyncIntervalMs,
      // First-sync deadline override (see nexusBootSyncDeadlineMs). The
      // backend uses this opts.deadlineMs only for the initial sync; later
      // polls keep the transport default. The field is OPTIONAL on the
      // backend config — when absent, behavior matches pre-PR (transport
      // default). Specifying it is the supported path for bounded
      // assert-remote-policy-loaded-at-boot semantics.
      bootSyncDeadlineMs:
        config.nexusBootSyncDeadlineMs ?? NEXUS_BOOT_SYNC_DEADLINE_MS_DEFAULT,
      // … existing config …
    });

    // Step 4: policy-load check — ONLY in assert-remote-policy-loaded-at-boot mode.
    // CONTRACT: this gates that remote policy was LOADED at boot. It does NOT
    // gate that remote policy will be ENFORCED for every check — current
    // permission composition chains to local TUI on ask/no-opinion results
    // (runtime-factory.ts:1797-1806). Strict centralized enforcement requires
    // a separate permission-composition change tracked outside this PR.
    // ASSEMBLY-FAILURE TEARDOWN: every Nexus resource constructed in this
    // block must be deterministically disposed when an assert-* throw aborts
    // boot, otherwise a live poll timer + transport activity leaks after
    // createKoiRuntime() rejects (the runtime's outer cleanup runs only on
    // successful return). Use a try/catch that disposes nexusPermBackend
    // (which started polling in ready.finally) before re-throwing.
    try {
    if ((config.nexusBootMode ?? "telemetry") === "assert-remote-policy-loaded-at-boot") {
      // BOUNDED first-sync wait. The backend's `ready` promise resolves after
      // an internal `transport.call("read", ...)` for version.json + policy.json
      // — but those calls inherit the transport's DEFAULT 45s deadline, not
      // the 5s HEALTH_DEADLINE_MS we used for the probe. Without an
      // independent bound here, "fail-fast" assert-remote-policy-loaded-at-
      // boot can still hang the CLI for tens of seconds against a slow /
      // unresponsive Nexus before failing closed — a user-visible availability
      // regression that is hard to diagnose because the probe already
      // returned quickly.
      //
      // Two-step bound:
      //   (a) the backend is constructed with a startup-deadline option that
      //       overrides per-call transport deadline for the FIRST sync only
      //       (subsequent polls keep the normal 45s default — operators who
      //       want bounded poll deadlines tune nexusSyncIntervalMs +
      //       transport defaults separately).
      //   (b) we ALSO wrap `await backend.ready` in a Promise.race against
      //       the same deadline as a defense-in-depth bound — implementation
      //       skew between backend and runtime cannot reintroduce the hang.
      const bootSyncDeadlineMs =
        config.nexusBootSyncDeadlineMs ?? NEXUS_BOOT_SYNC_DEADLINE_MS_DEFAULT;
      // Pull the AbortController the backend was constructed with so timeout
      // can ACTIVELY ABORT the in-flight first-sync transport.call instead of
      // just abandoning the promise. Without this, a failed boot can leave a
      // live `read` request hitting the shared transport and the backend's
      // initializePolicy() can mutate state AFTER dispose() — both are
      // shutdown hazards.
      const result = await Promise.race([
        nexusPermBackend.ready.then(() => "ready" as const),
        new Promise<"timeout">((resolve) => {
          const t = setTimeout(() => resolve("timeout"), bootSyncDeadlineMs);
          // unref so a quick-resolve `ready` doesn't keep the timer alive
          if (typeof t === "object" && t !== null && "unref" in t) (t as { unref: () => void }).unref();
        }),
      ]);
      if (result === "timeout") {
        // ABORT the in-flight sync BEFORE we throw, so the transport.call
        // settles (rejected with AbortError) instead of completing async after
        // the caller has already failed boot. dispose() in the catch handler
        // also clears poll timers, but only abort cancels the in-flight read.
        nexusPermBackend.abortInFlightSync?.();
      }
      if (result === "timeout") {
        throw new Error(
          `Nexus first-sync timed out after ${bootSyncDeadlineMs}ms; ` +
          `assert-remote-policy-loaded-at-boot mode requires remote policy loaded at boot. ` +
          `(The probe succeeded quickly but the permission backend's first sync is slower; ` +
          `tune nexusBootSyncDeadlineMs if Nexus reads legitimately need longer than the default ` +
          `${NEXUS_BOOT_SYNC_DEADLINE_MS_DEFAULT}ms.)`,
        );
      }
      if (!nexusPermBackend.isCentralizedPolicyActive()) {
        throw new Error(
          "Nexus remote policy not loaded after first sync (file missing, parse error, or backend rebuild failed); " +
          "assert-remote-policy-loaded-at-boot mode requires remote policy loaded at boot. " +
          "Note: this mode does NOT prevent local-rule fallback for queries not matched by remote policy.",
        );
      }
    }
    // telemetry / assert-transport-reachable-at-boot: do NOT await ready (preserves existing async semantics)
    } catch (err: unknown) {
      // ASSEMBLY-FAILURE TEARDOWN — dispose every Nexus resource constructed
      // before the throw, then rethrow. Without this, a poll timer + transport
      // activity leaks after createKoiRuntime() rejects (the runtime's outer
      // shutdown path runs only on successful return). Failure to dispose
      // here is the difference between "fail-fast assert mode rejects cleanly"
      // and "fail-fast assert mode leaks a live polling backend".
      try {
        nexusPermBackend?.dispose?.();
      } catch (disposeErr: unknown) {
        logger.warn({ err: disposeErr }, "nexus permission backend dispose failed during assert-* teardown");
      }
      throw err;
    }
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
  if (txKind !== undefined && auditEnabled === true) {
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
      // STRENGTHENED gate: at least one local sink must be REQUIRED (durable
      // — fail-stop on poison), not just configured. A best-effort local sink
      // would log on failure and continue, satisfying the previous weaker
      // "configured" check while still losing audit writes silently.
      const hasRequiredLocalSink =
        (ndjsonSinkConfigured && config.ndjsonRequired === true)
        || (sqliteSinkConfigured && config.sqliteRequired === true);
      if (!hasRequiredLocalSink) {
        throw new Error(
          'nexusAuditMode="local-only" requires at least one REQUIRED local ' +
          "audit sink (NDJSON or SQLite with required=true). A configured-" +
          "but-best-effort sink can silently drop writes on failure, defeating " +
          "the local-only fallback guarantee.",
        );
      }
    }
    if (isLocalBridge) {
      // local-bridge always skips the Nexus sink (no "require" path)
      logger.info({ mode: config.nexusAuditMode },
        "nexus audit sink not wired on local-bridge per nexusAuditMode");
    } else if (config.nexusAuditMode === "disabled") {
      // HTTP + nexusAuditMode=disabled: explicit opt-out; honor it.
      // (Without this branch, HTTP would unconditionally wire the sink even
      // though probe gating skipped probe work — a split-brain configuration.)
      logger.info({ mode: "disabled" },
        "nexus audit sink not wired on http per nexusAuditMode=disabled");
    } else {
      const onError = config.nexusAuditPoisonOnError === true
        ? (err: unknown) => {
            if (nexusPoison.err === undefined) nexusPoison.err = err;  // per-sink fail-stop
            logger.error({ err }, "nexus audit sink poisoned");
          }
        : (err: unknown) => logger.warn({ err }, "nexus audit write failed (best-effort)");
      const inner = createNexusAuditSink({ transport: config.nexusTransport, onError });
      // ALWAYS wrap with poisonedSink — even in default (poison-off) mode
      // the wrapper is a pass-through closure when the latch is never set.
      // In opt-in mode the wrapper rejects post-latch log() calls so
      // post-poison records cannot enter the inner sink's buffer (closes
      // the silent-loss window the Loop-4-R9 finding flagged in the prior
      // wiring snippet that pushed the inner sink directly).
      const wrappedNexusSink = poisonedSink(inner, nexusPoison);
      auditSinks.push(wrappedNexusSink);
      // Reuse THIS wrapped instance for the compliance-recorder + any
      // ledger/query path so the wrapper applies uniformly to every
      // consumer of the Nexus sink. Construct once, reuse everywhere.
      nexusSinkForCompliance = wrappedNexusSink;
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

**Naming intentionally drops `fail-closed-` prefix (Round 7 + Loop 3 Round 2 follow-up):** both non-telemetry modes were renamed because `fail-closed-*` invited operator confusion about authorization guarantees they do not provide.

- `assert-transport-reachable-at-boot` (was `fail-closed-transport`): proves the JSON-RPC transport carries `version` + the policy reads at boot. Does NOT block runtime exposure on first-sync completion, does NOT change permission composition.
- `assert-remote-policy-loaded-at-boot` (was `fail-closed-remote-policy-loaded`): also asserts first sync produced a remote-policy backend at boot. Does NOT enforce freshness or revocation propagation post-boot — last-known-good remote policy is preserved indefinitely under partition / 404 / parse failure.

**Both modes are STARTUP DIAGNOSTIC GATES, not authorization controls. Neither mode is a security-facing control and neither should be configured to satisfy a compliance requirement.** Compliance/security deployments that need pre-sync authorization enforcement must wait for the follow-up control-plane work tracked as out-of-scope below — running this PR's modes in their place produces a false-safety signal. They do NOT guarantee:
- That subsequent sync attempts succeed (network partition / Nexus down → node continues serving last-known-good remote policy indefinitely)
- That central-side policy changes (revocations, tightened denies) propagate within any bounded time
- That a withdrawn policy file (404 after first load) demotes the node — last-known-good is preserved by design (availability over consistency)
- That **all queries are authorized by remote policy** — local TUI rules still answer queries the remote policy doesn't cover
- That early requests cannot authorize against local TUI rules before first remote sync completes (under `assert-transport-reachable-at-boot`)

Operators wanting blocking-first-sync, freshness enforcement, or revocation propagation need a different control plane — explicitly out of scope this PR, tracked as follow-up. The renamed modes preserve option-space for that future without misrepresenting today's guarantees.

Runtime config validation MAY warn (not throw) if `assert-remote-policy-loaded-at-boot` is selected without any out-of-band freshness mechanism (e.g., short `nexusSyncIntervalMs` + alerting on backend.lastSyncError) so operators don't conflate the two guarantees.

**Type-system enforcement:** the runtime config field is typed as base `NexusTransport` (since long-lived local-bridge transports do not expose `health`). HTTP transports happen to also satisfy `HealthCapableNexusTransport` and are upcast at the probe site. The `as unknown as NexusTransport` cast in `tui-command.ts:1704` is dropped — fs-nexus local-bridge structurally satisfies `NexusTransport` directly once the `kind` discriminator is added. `assertHealthCapable` is exported for callers who hold a base `NexusTransport` and need to narrow before invoking `health()` themselves (e.g., custom probe wrappers); it is NOT used in the standard tui-command path.

**Why this is the right policy:**

- Default mode preserves the existing local-first contract — no regression
- Operators get visibility into Nexus health via logs at every startup
- Compliance/security deployments opt in to `assert-transport-reachable-at-boot` or `assert-remote-policy-loaded-at-boot` explicitly
- The golden test for local-first fallback continues to pass unchanged

`assertHealthCapable<T extends NexusTransport>(t: T): asserts t is T & HealthCapableNexusTransport` is the assertion helper.

## Files

| File | Change | Est LOC |
|---|---|---|
| `packages/lib/nexus-client/src/types.ts` | Add `NexusCallOptions` (deadlineMs, nonInteractive), `NexusHealthOptions` (readPaths), `NexusHealth`, **optional** `kind?: NexusTransportKind` on `NexusTransport` (preserves source-compat for structural mocks), optional `health` on `NexusTransport`, required `health` on `HealthCapableNexusTransport`; extend `call` signature with optional `opts` (additive — existing call sites without opts still type-check); add `assertProductionTransport(t)` helper that THROWS unconditionally when `t.kind` is undefined (both phases). Skip-and-warn was rejected as Phase 1 behavior because pre-PR semantics implicitly wired both Nexus consumers — silent skip on upgrade would be an auth/audit bypass. Error message names every named factory (`createHttpTransport`, fs-nexus HTTP wrapper, `createLocalBridgeTransport`, `createLocalBridgeProbeTransport`) AND the explicit opt-out path (`nexusPermissionsEnabled=false` + `nexusAuditEnabled=false`). | +40 |
| `packages/lib/nexus-client/src/transport.ts` | HTTP impl: thread `opts.deadlineMs` into existing `AbortSignal.timeout`; **thread `opts.signal` into `fetch(..., { signal })` via `AbortSignal.any([deadlineSignal, opts.signal])` so caller cancellation maps to fetch abort; reject with `KoiError code:"ABORTED"` distinct from deadline-driven `code:"TIMEOUT"`**; implement `health(opts?)` — version probe + one `read` per `opts.readPaths` (default `koi/permissions/version.json` + `koi/permissions/policy.json`); **validate each read body with the canonical `extractReadContent` extractor (returns string from string OR `{content: string}`; rejects every other shape with VALIDATION error)** — bodies are NOT discarded so the probe matches the permission backend's parse contract and a malformed-but-200 payload fails health rather than later first-sync; return `HealthCapableNexusTransport` | +75 |
| `packages/lib/nexus-client/src/extract-read-content.ts` | New: canonical `extractReadContent(payload: unknown): Result<string, KoiError>` extractor — single source of truth for how a `read` body decodes into the policy YAML/text. Owned by `@koi/nexus-client` (lowest layer that needs it). `@koi/permissions-nexus` is updated in this PR to import + use this extractor instead of its current ad-hoc destructuring, so health() and the backend can NEVER drift on payload shape | +35 |
| `packages/lib/nexus-client/src/extract-read-content.test.ts` | New: accepts string body; accepts `{content: "..."}` body; rejects null / array / number / object-without-content / `{content: 42}` / `{content: undefined}` with `code: "VALIDATION"`; error message names the two accepted shapes | +60 |
| `packages/lib/nexus-client/src/health.test.ts` | New: all probes ok → ok+probed lists each path; either read returns 404 → still ok; version 5xx → fail; any read 5xx → fail; read 401 → fail; per-call deadline honored; network error; malformed version response; nonInteractive flag set on all calls; **custom readPaths override default** (probes provided paths only) | +200 |
| `packages/lib/nexus-client/src/assert-health-capable.ts` | New: `assertHealthCapable` assertion function | +15 |
| `packages/lib/nexus-client/src/assert-health-capable.test.ts` | New: present narrows; missing throws | +25 |
| `packages/lib/nexus-client/src/index.ts` | Re-export `NexusHealth`, `HealthCapableNexusTransport`, `assertHealthCapable` | +3 |
| `packages/lib/fs-nexus/src/local-transport.ts` | (1) Per-call `opts.deadlineMs` for use by the disposable probe. (2) Per-call `opts.nonInteractive` — on `auth_required`: reject in-flight call and kill the subprocess (disposable-probe path only). (3) **Per-call `opts.signal` — pending-request map keyed by JSON-RPC id; on signal abort send a `cancel` notification to the bridge, reject the pending call with `code:"ABORTED"`, free the slot. Required so `permission-backend.abortInFlightSync()` works on local-bridge as well as HTTP (HTTP gets it free via fetch).** (4) Add `kind: "local-bridge"` discriminator. **Does NOT implement `health()`** — long-lived local-bridge transport stays at base `NexusTransport`. Probing the live session is unsafe (auth wedge); `health()` only exists on the disposable probe variant. | +85 |
| `packages/lib/fs-nexus/src/transport.ts` | **Forward `health` from the wrapped HTTP transport** (currently this fs-nexus HTTP wrapper drops it, returning only `{ call, close, subscribe, submitAuthCode }`). Add `health` passthrough so the type contract upgrade in runtime-factory works for HTTP path. Add `kind: "http"` discriminator. | +20 |
| `packages/lib/fs-nexus/src/transport.test.ts` | New: HTTP wrapper forwards `health()` calls to underlying transport; result shape preserved; opts pass through | +50 |
| `packages/lib/fs-nexus/src/probe-transport.ts` | New: `createLocalBridgeProbeTransport(spawnConfig): HealthCapableNexusTransport` — spawns a fresh, short-lived bridge subprocess; the ONLY local-bridge variant that implements `health()`; closes itself after the call. spawnConfig is held in closure scope, never on the returned transport object (no credential leak). | +75 |
| `packages/lib/fs-nexus/src/probe-transport.test.ts` | New: probe spawns isolated subprocess; health() returns ok when bridge healthy; health() returns error when bridge auth-blocked (nonInteractive); probe subprocess is killed after probe regardless of result; probe failure does NOT affect any concurrently-running session transport | +110 |
| `packages/lib/fs-nexus/src/local-transport.test.ts` | New: per-call deadline rejects before transport default; long-lived session transport does NOT receive nonInteractive flag from runtime probe path; existing call/subscribe behavior unchanged | +80 |
| `packages/security/permissions-nexus/src/nexus-permission-backend.ts` | Add `isCentralizedPolicyActive(): boolean` — read-only query of currently-serving backend (true iff serving remote, regardless of latest sync outcome); preserves existing skip-bad-update behavior. (Round 10 trim: `deferInitialSync` and `triggerImmediateSync` REMOVED — both existed solely to soften local-bridge auth-wedge, which is now categorically rejected upstream.) **Add optional `bootSyncDeadlineMs` config field** — when set, the FIRST-sync `transport.call("read", ...)` calls pass `{deadlineMs: bootSyncDeadlineMs}` so they cannot inherit the transport's 45s default. Subsequent polls use the transport default unchanged. **Add `abortInFlightSync()` method + internal `AbortController` threaded into the first-sync `transport.call(...)` `signal`** — when called, it aborts the in-flight read so `initializePolicy()` cannot mutate backend state after `dispose()`. State-mutation guard: any `initializePolicy()` resolution that lands AFTER `abortInFlightSync()` or `dispose()` is silently dropped (no skip-bad-update path triggered). Without these, the assert-remote-policy-loaded-at-boot timeout path leaves a live `read` request running against the shared transport. | +50 |
| `packages/security/permissions-nexus/src/nexus-permission-backend.test.ts` | New tests: false before any sync; false when first sync fails (404/parse/rebuild mismatch — no last-known-good); true after first successful sync; stays true when subsequent sync fails (last-known-good preserved); stays true when subsequent sync produces incompatible policy (skipped, last-known-good preserved) | +60 |
| `packages/meta/cli/src/runtime-factory.ts` | Type `nexusTransport` as base `NexusTransport` (long-lived session has no health); add `nexusBootMode`, `nexusPolicyPath`, `nexusAuditPoisonOnError`, `nexusPermissionsEnabled`, `nexusAuditEnabled`, `nexusAuditMode`, `nexusSyncIntervalMs` config fields (Loop 3 Round 1: `nexusProbeFactory` REMOVED — was dead in runtime; standalone probe is caller-site only); **Phase 1 deprecation:** HTTP transport with unset `nexusPermissionsEnabled`/`nexusAuditEnabled` infers TRUE + warns (Phase 2 throws). Local-bridge with unset flags THROWS unconditionally (no inference) — fs-only sessions must use the tui-command.ts decoupling and not pass `nexusTransport` into the runtime. Local-bridge + explicit `nexusPermissionsEnabled=true` THROWS (security gate, both phases). **Probe + consumer wiring gated on resolved flags:** if both effective consumer flags are false, the entire Nexus startup block is SKIPPED — explicit fs-only HTTP configurations also unaffected. runtime probes HTTP transports only (in-place); local-bridge probing is caller-site responsibility via the exported `createLocalBridgeProbeTransport` and is never invoked from the runtime; preflight: throw on local-bridge + fail-closed-* (unsupported); thread `nexusPolicyPath` into BOTH `health()` readPaths AND `createNexusPermissionBackend`; telemetry mode: log probe failure but always wire consumers; fail-closed-* throws on probe failure; in `assert-remote-policy-loaded-at-boot`, await `nexusPermBackend.ready` and check `isCentralizedPolicyActive()`; **preserve per-sink poison latches (NDJSON, SQLite, Nexus each independent) AND existing per-sink fail-stop admission semantics** — pre-PR NDJSON/SQLite required-sink behavior is unchanged; Nexus joins on the same terms when `nexusAuditPoisonOnError === true`. NO quorum gate. Optional sinks (default) log only; **add early-throw validation** when `local-bridge + telemetry + nexusSyncIntervalMs===0` (deferred sync would never fire, deadlocking `ready`); route Nexus sink errors into it ONLY when `nexusAuditPoisonOnError === true` (default best-effort); existing middleware admission guards now cover Nexus too via per-sink poison latch; **wire Nexus compliance-recorder `onError` to latch `nexusPoison` in opt-in mode (admission gate then refuses new work at next boundary; poisoned-sink wrapper rejects post-poison log() calls). NO `process.exit(1)` — Nexus is a remote dependency and the runtime exposes no coordinated shutdown primitive today, so synchronous hard-exit on async remote failure is explicitly out-of-scope. Best-effort logging in default mode (was silent — bug fix). Coordinated-shutdown follow-up tracked under "Out of scope".** | +145 |
| `packages/security/audit-sink-nexus/src/config.ts` | **Add `onError?: (err: unknown) => void` to `NexusAuditSinkConfig`** — the field doesn't exist today; wrapper depends on it | +8 |
| `packages/security/audit-sink-nexus/src/nexus-sink.ts` | Remove silent `.catch(() => {})` on `startFlush()`; invoke `config.onError?.(err)` on flush failure (interval-triggered AND size-triggered AND explicit-flush-triggered paths must all route through `onError`) | +12 |
| `packages/security/audit-sink-nexus/src/nexus-sink.test.ts` | New: interval-triggered flush failure invokes `onError`; size-triggered flush failure invokes `onError`; explicit `flush()` failure invokes `onError`; `onError` undefined doesn't crash (regression guard against silent swallowing) | +60 |
| `packages/meta/cli/src/__tests__/runtime-factory-nexus-audit-poison.test.ts` | New tests: default (`nexusAuditPoisonOnError` unset) — Nexus middleware errors stay out of per-sink poison latch; admission boundaries do NOT block; best-effort preserved. Opt-in (`true`) — Nexus middleware error latches shared `auditPoisonError`; admission boundaries refuse work. **Compliance-recorder coverage (both modes):** default — failure logs warning (was silent regression); opt-in — failure latches `nexusPoison`; admission gate refuses new work at next boundary; poisoned-sink wrapper rejects subsequent log() calls. Test asserts that NO `process.exit` occurs (regression guard against accidentally re-introducing a hard-exit path now that the spec scopes it out) | +200 |
| `packages/meta/cli/src/__tests__/runtime-factory-health.test.ts` | New tests covering all three modes + activation race coverage (see Tests section) | +200 |
| `packages/meta/cli/src/tui-command.ts` | Drop the `as unknown as NexusTransport` cast at line 1704 — fs-nexus local-bridge transport now structurally satisfies base `NexusTransport` directly (after fs-nexus adds `kind: "local-bridge"` discriminator). **Architectural decoupling (this PR):** when neither `nexusPermissionsEnabled` nor `nexusAuditEnabled` resolves to true, do NOT pass `nexusTransport` into `createKoiRuntime` at all — fs-only sessions use the local-bridge transport directly through the fs-nexus path and bypass the Nexus consumer block entirely. This eliminates the contradictory upgrade tradeoff (warn-and-infer-false vs hard-throw on no-flags): callers reaching the Nexus block always intentionally enabled at least one consumer. When constructed, the probe factory captures its own copy of the spawn config. | +20 |
| `packages/meta/cli/src/nexus-config.ts` | **NEW shared module** — single source of truth for parsing `KOI_NEXUS_*` env vars and `--nexus-*` CLI flags into the `KoiRuntimeFactoryConfig` Nexus subset. Exported `parseNexusConfigFromEnvAndFlags(env, flags) → Pick<KoiRuntimeFactoryConfig, "nexusPermissionsEnabled" \| "nexusAuditEnabled" \| "nexusAuditMode" \| "nexusAuditPoisonOnError" \| "nexusBootMode" \| "nexusPolicyPath" \| "nexusSyncIntervalMs" \| "nexusBootSyncDeadlineMs">`. Used by BOTH `tui-command.ts` AND `commands/start.ts` so the new boot gate, consumer wiring, and assert-* preflight are uniform across interactive and headless entrypoints. Without this module, the headless path silently bypasses every new safety check. | +90 |
| `packages/meta/cli/src/commands/start.ts` | **Wire shared `parseNexusConfigFromEnvAndFlags(...)`** into the existing headless boot path that calls `createKoiRuntime(...)`. Today `koi start` only supplies a filesystem backend (`packages/meta/cli/src/commands/start.ts:493-584` and `:786-896`); after this PR it ALSO threads Nexus consumer flags + boot mode through to runtime config. **Default-preserving rule:** `nexusTransport` is constructed and passed ONLY when the operator explicitly sets `nexusPermissionsEnabled=true` OR `nexusAuditEnabled=true`. With no `KOI_NEXUS_*` flags set (the existing-headless-deployment baseline), `nexusTransport` is NOT constructed and `koi start` keeps its current filesystem-only behavior — even when `manifest.filesystem.backend === "nexus"`. This avoids silently turning on Nexus permissions + audit for legacy headless HTTP Nexus filesystem deployments on upgrade (the HTTP unset-flags-infer-true rule fires only when the operator HAS chosen to pass `nexusTransport`; gating transport construction on explicit consumer flags makes the rule unreachable for legacy headless callers). Local-bridge headless boots that DO set explicit consumer flags follow the same assert-*/poison contracts as TUI. | +75 |
| `packages/meta/cli/src/__tests__/start-nexus-wiring.test.ts` | New: headless `koi start` with `KOI_NEXUS_BOOT_MODE=assert-remote-policy-loaded-at-boot` + healthy HTTP transport boots; same with unreachable transport throws (proves headless honors the gate); `KOI_NEXUS_AUDIT_POISON=true` headless propagates to runtime config; legacy headless deployments without any `KOI_NEXUS_*` vars still boot with current behavior (regression guard) | +120 |
| `packages/meta/cli/src/__tests__/nexus-config.test.ts` | New: tri-state parsing for every flag; mutual-exclusion enforcement for `--nexus-*` / `--no-nexus-*`; `KOI_NEXUS_BOOT_MODE` rejects unknown values with actionable message; legacy `require` audit-mode rejected; numeric fields parse + bound-check | +110 |
| `docs/L2/nexus-client.md` | Document readiness probe semantics; `HealthCapableNexusTransport` contract; WS/gRPC/pool out-of-scope rationale | +60 |

**Total: ~1075 LOC (335 src + 680 test + 60 doc).**

(Larger than the original ~170 estimate because reviews correctly demanded real integration, type-system enforcement, and a readiness probe — not just a dead liveness API.)

## Tests (TDD — written before code)

`packages/lib/nexus-client/src/health.test.ts`:

1. `health() with default opts probes version + version.json + policy.json; returns Result.ok({ status: "ok", probed: [...] }) when all succeed`
2. `health({ readPaths: ["custom/v.json"] }) probes only the supplied paths; default paths NOT probed`
3. `health() returns Result.ok({ status: "missing-paths", notFound: [<path>] }) when any read returns 404 — NOT status: "ok" (forces caller handling; closes the false-readiness hazard from the prior shape)`
3a. `health() collects 404s for ALL paths (no short-circuit) — multi-path probes report the full notFound[] for operator diagnostics`
3b. `health() returns Result.ok({status:"missing-paths"}) even when only ONE of N paths 404s — partial-namespace is still fail-closed`
3c. `health({readPaths: []}) returns Result.ok({status:"version-only", probed:["version"]}) — version-only is a distinct discriminator, NOT "ok" (Loop 4 R7 — closes the false-readiness hazard for empty-readPaths probes)`
3d. `health() with no readPaths option (defaults to DEFAULT_PROBE_PATHS): returns "ok" or "missing-paths" — version-only ONLY fires for explicit empty array`
4. `health() returns Result.error when version probe returns 503`
5. `health() returns error when any read returns 503` — proves we don't stop after first read
6. `health() returns error when any read returns 401 (auth failure)`
7. `health() passes nonInteractive=true and deadlineMs on every transport.call`
8. `health() honors per-call deadline (rejects within HEALTH_DEADLINE_MS)`
5. `health() returns error on timeout shorter than default deadline`
6. `health() returns error on network failure`
7. `health() returns error on malformed version response`
7a. `health() returns VALIDATION error when read returns 200 with body that is neither string nor {content: string}` (closes false-negative: same extractor as permission backend, malformed payload would later cause sync parse-error demotion)
7b. `health() accepts read 200 with body = "yaml content as string"` (string form)
7c. `health() accepts read 200 with body = {content: "yaml content"}` (envelope form)
7d. `health() rejects read 200 with body = {data: "..."}` (wrong field name — would parse-fail in backend)
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
7f. (REMOVED Loop 3 Round 3 — runtime no longer probes local-bridge; spawn-config validation is caller-site only via `createLocalBridgeProbeTransport`)
7g. `local-bridge + assert-transport-reachable-at-boot mode: throws config validation error (unsupported) — fires UNCONDITIONALLY before consumer-resolution gate, so even no-op consumer combinations still get the loud rejection`
7h. `local-bridge + assert-remote-policy-loaded-at-boot mode: throws config validation error (unsupported) — same unconditional path as 7g`
7h_unc1. `local-bridge + nexusAuditMode="local-only" + assert-transport-reachable-at-boot: STILL throws (anyEffectiveConsumer=false would otherwise skip the block — regression guard against the Round 5 silent-skip bug)`
7h_unc2. (REMOVED Loop 4 R8 — same superseding rationale as 7h_unc3/4: explicit opt-out is the locked rollback contract, so assert-* on opt-out does not throw. Coverage moved to 7h_unc10)
7h_unc3. (REMOVED Loop 4 R8 — superseded by 7h_unc9/10. R2 wrote this test to close the Round-2 raw-kind bypass, but R7 made explicit opt-out a hard rollback contract that wins over assert-* preflight. Both expectations cannot hold; the rollback contract is the locked decision and these throw cases are deleted)
7h_unc4. (REMOVED Loop 4 R8 — same superseding rationale as 7h_unc3)
7h_unc5. `local-bridge + same opt-out + nexusBootMode="telemetry" (or unset): BOOTS without Nexus block (opt-out path is honored only when the boot mode is compatible with local-bridge)`
7h_unc6. (REMOVED Loop 4 R8 — superseded by 7h_unc11. R3 expected throw on missing-kind + opt-out + assert-*; R7 made opt-out a hard rollback contract that wins over every Nexus boot gate including the kind assertion. Both expectations cannot hold; rollback contract is locked)
7h_unc7. `MISSING KIND adapter + same opt-out + nexusBootMode="telemetry": BOOTS without Nexus block (assert-* gate fires only on assert-* modes; telemetry opt-out for legacy adapters is preserved)`
7h_unc8. `assert-* preflight throw message names "positively-identified HTTP transport" so operators understand the gate fires on missing-kind + local-bridge + any other non-HTTP shape uniformly`
7h_unc9. `EXPLICIT opt-out (perms=false + audit=false) + ANY nexusBootMode (including assert-*): BOOTS without throw + logs ONE WARN naming the dead config (Loop 4 R7 — opt-out is a hard rollback contract, not a stricter gate)`
7h_unc10. `EXPLICIT opt-out + assert-remote-policy-loaded-at-boot + local-bridge transport: STILL boots with warning (no probe, no consumer wiring, no kind assertion fires — verifies opt-out wins over every Nexus boot gate uniformly)`
7h_unc11. `EXPLICIT opt-out + UNDISCRIMINATED transport + assert-*: BOOTS with warning (opt-out also short-circuits the kind assertion — already covered by 7g16u6 but verified end-to-end here with stale assert-* config to prove the migration table claim)`
7g2. (REMOVED Loop 3 — nexusProbeFactory removed from runtime config; no runtime test applies)
7g2b. (REMOVED — same)
7g3. (REMOVED — runtime no longer consumes nexusProbeFactory)
7g4. `HTTP transport probe success logs probeScope=session-validated`
7g5. `long-lived local-bridge transport object does NOT have a health method` (regression guard against unsafe in-place probing)
7g6. (REMOVED — deferInitialSync no longer exists; mitigation was for local-bridge permissions which are now categorically rejected)
7g7. (REMOVED — same)
7g8. (REMOVED — same)
7g10. (REMOVED — deferred-sync deadlock case no longer reachable)
7g11. `Required NDJSON sink failure latches ndjsonPoison; admission DENIED on next boundary` (per-sink fail-stop preserved — matches pre-PR semantics exactly)
7g12. `Required SQLite sink failure latches sqlitePoison; admission DENIED on next boundary` (per-sink fail-stop, regardless of NDJSON state)
7g12b. `Optional (non-required) sink poisoned: admission CONTINUES; failure logged only` (optional sinks never block)
7g12c. `Nexus with nexusAuditPoisonOnError=true poisoned: admission DENIED on next boundary` (Nexus joins per-sink fail-stop; no quorum)
7g12c2. `poisonedSink wrapper: post-latch log() calls REJECT with code="AUDIT_SINK_POISONED" carrying the latched error as cause (not silent resolve)` — proves layer (a) of the two-layer fail-stop guarantee AND that compliance-recorder's onError fires
7g12c3. `poisonedSink wrapper exposes "dropped" counter incremented on each post-latch log() call` (telemetry visibility, complementary to the rejection)
7g12c4. `Records that arrive between sink-error and next admission boundary: ALL rejected by wrapper (compliance-recorder onError fires for each), NONE accepted by inner sink` — closes the silent-loss window the reviewer flagged
7g12c4b. `compliance-recorder onError observes the AUDIT_SINK_POISONED rejection (regression guard against the silent-resolve bug — confirms the rejection is the signal that surfaces post-poison failures)`
7g12c5. `nexusAuditPoisonOnError=false: poisonedSink wrapper is no-op pass-through (latch never set, delegates every log() to inner)`
7g12c6. `Same poisonedSink wrapper used for NDJSON, SQLite, and Nexus sinks (single implementation, no per-sink divergence)` — regression guard against drift
7g12c7. `Compliance-recorder receives the SAME wrapped Nexus sink instance as auditSinks.push (NOT the bare inner sink)` — Loop 4 R9 closes the wiring drift where compliance-recorder bypassed the wrapper
7g12c8. `Default mode (nexusAuditPoisonOnError unset/false): poisonedSink wrapper still wraps the Nexus sink as a pass-through closure (never sets latch); proves the wrapper is unconditional infrastructure, not opt-in glue that can be skipped` — regression guard against future wiring that "skips wrapping when poison-off"
7g12d. `Nexus with nexusAuditPoisonOnError=false poisoned: admission CONTINUES; failure logged` (best-effort default has no admission impact)
7g12e. `Pre-PR NDJSON+SQLite both required, NDJSON-only failure halts admission: behavior UNCHANGED` (regression guard against quorum drift)
7g13. (REMOVED — superseded by 7g16o which throws rather than warns)
7g14. `local-bridge + audit-enabled WITHOUT nexusAuditMode: throws config error at boot` (security gate; no implicit-default fallback for local-bridge audit)
7g15. (REMOVED — "require" mode no longer exists; local-bridge audit always skips the Nexus sink)
7g16. `local-bridge + nexusAuditMode="local-only" + NDJSON sink configured AND ndjsonRequired=true: Nexus sink skipped; boot succeeds`
7g16b. `local-bridge + nexusAuditMode="local-only" + NO local sinks: throws config error (prevents silent audit data loss)`
7g16b2. `local-bridge + nexusAuditMode="local-only" + NDJSON sink configured but ndjsonRequired=undefined/false: throws config error (best-effort sink does not satisfy local-only)` (strengthened gate — Round 9)
7g16b3. `local-bridge + nexusAuditMode="local-only" + SQLite required=true: same — sqliteRequired=true also satisfies the gate`
7g16c. `local-bridge + nexusAuditMode="disabled": Nexus sink skipped; no fallback assertion; boot succeeds`
7g16d. (REMOVED Loop 3 Round 3 — superseded by 7g16j13: HTTP honors `nexusAuditMode="disabled"` by skipping the sink. "Always wired" was the pre-Round-10 contract)
7g16e. `nexusPermissionsEnabled=true + local-bridge: throws security gate at boot in BOTH phases` (no warn-and-continue path; no migration table fall-through)
7g16f. `nexusPermissionsEnabled=true + HTTP: wired normally`
7g16g. (REMOVED — nexusPermissionsOnLocalBridgeAck no longer exists)
7g16h. `nexusTransport set + nexusPermissionsEnabled UNSET: Phase 1 — boots with deprecation warning, infers true (existing v2 behavior); Phase 2 — throws`
7g16i. `nexusPermissionsEnabled=false explicitly: permissions skipped; no warning; audit-only deployment boots`
7g16j. `nexusPermissionsEnabled=true + HTTP: permissions wired normally`
7g16j2. `nexusTransport set + nexusAuditEnabled UNSET: Phase 1 — same warning + infer-true; Phase 2 — throws`
7g16j3. `nexusAuditEnabled=false: Nexus audit sink skipped regardless of nexusAuditMode value`
7g16j4. `nexusAuditEnabled=true + HTTP + nexusAuditMode unset OR "local-only": sink wired (HTTP has no wedge surface; only "disabled" suppresses wiring — see 7g16j13)`
7g16j5. `local-bridge + nexusAuditEnabled=false: nexusAuditMode is NOT required (regression guard — backward-compat scoping)`
7g16j6. `Phase 1 deprecation warning fires on HTTP only (unset flags → infer true + warn). Local-bridge unset flags THROWS instead (no warning path) — see 7g16y` (single-source-of-truth: HTTP warns, local-bridge throws)
7g16j7. `Both consumers explicitly false (any transport): startup probe is SKIPPED entirely; runtime does not call probeTransport.health()` (fs-only Nexus session — probe is none of this block's concern)
7g16j8. (REMOVED Loop 3 Round 3 — local-bridge no-flags now THROWS upstream (see 7g16y); "inferred false" code path no longer exists)
7g16j9. `One consumer enabled: probe runs as before` (regression guard against over-eager skip)
7g16j10. (REMOVED — runtime no longer consumes nexusProbeFactory; caller-site try/catch is operator responsibility)
7g16j11. `local-bridge + auditEnabled=true + nexusAuditMode="disabled": probe + boot-mode preflight SKIPPED` (effective-consumer gating — disabled-by-mode does not trigger Nexus startup work)
7g16j12. `local-bridge + auditEnabled=true + nexusAuditMode="local-only": same as above (no Nexus consumer effectively wired on local-bridge)`
7g16j13. `HTTP + auditEnabled=true + nexusAuditMode="disabled": probe SKIPPED AND audit sink NOT wired (Round 10 — wiring honors disabled on HTTP, not just probe)`
7g16j13b. `HTTP audit-only telemetry probe success (permissions=false): logs WARNING with msg "nexus probe partial: version reachable, audit-write readiness UNVALIDATED" (NOT "nexus probe ok") and partial:true field — closes the false-positive observability signal flagged in Loop 4 R2`
7g16j13c. `HTTP audit-only probe payload includes probeScope="version-only (audit write path NOT validated — no audit-readiness probe exists)" so log aggregators / dashboards can filter on the limitation`
7g16j13d. `HTTP perms+audit telemetry probe success: logs WARN with msg "nexus probe ok (with caveat): policy reads succeeded; audit-write readiness UNVALIDATED — failures will surface on first audit flush" + auditUnvalidated:true. NEVER logs a fully-green INFO line while audit is wired (Loop 4 R4 fix — audit write path is unprobed regardless of consumer wiring, so the limitation must surface uniformly)`
7g16j13e. `HTTP perms-only (audit explicitly disabled) telemetry probe success: logs INFO with msg "nexus probe ok: session-validated" + auditUnvalidated:false (the only path that gets the plain green log — audit isn't in scope for this deployment)`
7g16j13f. `Probe log payload always includes auditUnvalidated boolean field for downstream alerting (true whenever audit consumer is wired OR audit-only path active; false only when permissions wired and audit explicitly disabled)`
7g16j14. `local-bridge with nexusProbeFactory: probe is NOT executed by createKoiRuntime` (regression guard — local-bridge probe is caller-site responsibility, runtime block is HTTP-only)
7g16j15. `assert-transport-reachable-at-boot + 404 on version.json or policy.json: throws with 'namespace absent' message` (Round 9 plumbing now reaches throw)
7g16j16. `assert-remote-policy-loaded-at-boot + 404 on either default probe path: throws (same handling as assert-transport-reachable-at-boot)`
7g16j17. `telemetry mode + 404: logs warning with notFound list; boot CONTINUES`
7g16j18. `assert-transport-reachable-at-boot probe success + no 404: boots normally`
7g16j19. `assert-transport-reachable-at-boot + nexusPermissionsEnabled=false (audit-only HTTP): THROWS — version probe doesn't exercise audit write path, would be a false-negative gate. Error names "telemetry" as the only supported audit-only mode.`
7g16j20. `assert-remote-policy-loaded-at-boot + nexusPermissionsEnabled=false: THROWS (no policy backend to await). Same root cause as 7g16j19; both assert-* modes require permissions wired.`
7g16j21. `assert-transport-reachable-at-boot + nexusPermissionsEnabled=true: probe reads default policy paths; 404 still fatal` (regression guard — gating only loosens audit-only path, permissions path unchanged)
7g16j22. `assert-remote-policy-loaded-at-boot: backend.ready resolves within bootSyncDeadlineMs default (10s) → boots normally`
7g16j23. `assert-remote-policy-loaded-at-boot: backend.ready stalls past bootSyncDeadlineMs → THROWS with "Nexus first-sync timed out after Xms" actionable message naming nexusBootSyncDeadlineMs as the tunable` (regression guard against the Loop-4-R4 unbounded-await bug — fail-fast assert mode must be bounded end-to-end)
7g16j24. `assert-remote-policy-loaded-at-boot: custom bootSyncDeadlineMs=2000 enforces tighter bound; 3s simulated sync throws within ~2s (not 45s transport default)`
7g16j25. `Backend constructed with bootSyncDeadlineMs threads {deadlineMs} into FIRST-sync transport.call but NOT into subsequent poll calls` (regression guard — bound applies only to first sync)
7g16j26. `telemetry / assert-transport-reachable-at-boot modes: backend.ready is NEVER awaited regardless of bootSyncDeadlineMs (no timeout path can fire)`
7g16j27. `assert-remote-policy-loaded-at-boot first-sync timeout: nexusPermBackend.dispose() is called before the throw propagates (no live poll timer leak after createKoiRuntime rejects — Loop 4 R5)`
7g16j28. `assert-remote-policy-loaded-at-boot isCentralizedPolicyActive()===false: same disposal path before the throw`
7g16j29. `dispose() throwing during teardown is logged as warning + does NOT mask the original assert-* error (operator sees the actionable cause, not the disposal noise)`
7g16j30. `Successful boot path: dispose() is NOT called from the assert-* try/catch (only from runtime's outer shutdown handle — regression guard against double-dispose)`
7g16j31. `assert-remote-policy-loaded-at-boot timeout: abortInFlightSync() is called BEFORE the throw; in-flight transport.call("read", ...) settles with AbortError (proven via mock transport that records the AbortSignal it received)`
7g16j32. `Backend's initializePolicy() resolving AFTER abortInFlightSync() does NOT mutate backend state (drops the late resolution; isCentralizedPolicyActive() does not flip from false to true post-abort)`
7g16j33. `Backend's initializePolicy() resolving AFTER dispose() does NOT mutate state (state-mutation guard — same root cause coverage as 7g16j32 but driven by dispose path instead of timeout path)`
7g16j34. `HTTP transport: opts.signal aborts mid-flight — fetch is cancelled, returns Result.error code="ABORTED" distinct from code="TIMEOUT"` (Loop 4 R9 — abortInFlightSync depends on this end-to-end)
7g16j35. `Local-bridge transport: opts.signal aborts mid-flight — pending-request map removes the slot, sends cancel notification to bridge, returns code="ABORTED"`
7g16j36. `Both transports: signal that aborts AFTER the call settles is a no-op (no double-reject, no resource leak)`
7g16j37. `Permission backend: abortInFlightSync() observably aborts via the signal it threaded into transport.call (verified through a mock transport that records the AbortSignal it received)` — closes the Loop-4-R9 gap where the abort contract lacked an end-to-end transport API
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
7g16u. `assertProductionTransport: missing transport.kind THROWS at the production runtime boundary (both phases)` — error message names every named factory AND the explicit fs-only opt-out (`nexusPermissionsEnabled=false` + `nexusAuditEnabled=false`)
7g16u2. `Runtime caller-side check: when both consumer flags are explicitly false, runtime-factory SKIPS the assertProductionTransport call entirely; legacy structural adapter passes through unchanged for non-Nexus subsystems` (Round 8 ordering — assertion runs AFTER fs-only opt-out check)
7g16u3. (REMOVED Loop 3 Round 7 — Phase 2 no longer differs from Phase 1 for missing-kind; same throw both phases)
7g16u4. `Runtime: missing kind + explicit nexusPermissionsEnabled=true: THROWS at the runtime boundary (kind-assert reached because opt-out check failed)`
7g16u5. `Runtime: missing kind + explicit nexusAuditEnabled=true (perms unset): THROWS at runtime boundary (any non-opt-out path reaches the assertion)`
7g16u6. `Runtime: missing kind + explicit nexusPermissionsEnabled=false + explicit nexusAuditEnabled=false: BOOTS without Nexus block (fs-only opt-out path) — regression guard for the documented migration`
7g16u7. `Runtime: missing kind + nexusPermissionsEnabled UNSET + nexusAuditEnabled UNSET: THROWS (unset flags do NOT satisfy the explicit opt-out — operator must explicitly write false)`
7g16v. `assertProductionTransport returns transport unchanged when kind is set` (positive narrowing)
7g16w. `runtime-factory uses assertProductionTransport at every kind branch (no raw access to .kind)` (lint-style assertion via grep in test suite)
7g16x. `KOI_NEXUS_AUDIT_MODE=require: CLI parser rejects with actionable error naming local-only/disabled` (legacy value handling — old automation fails loud, not silent)
7g16y. `Phase 1 local-bridge with no flags: THROWS with actionable message naming both flags AND fs-only escape hatch ('do NOT pass nexusTransport into createKoiRuntime — see tui-command.ts decoupling')` (single behavior across spec/migration/tests; no inference; fs-only sessions use the decoupling instead)
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
11. `assert-transport-reachable-at-boot: throws on transport error`
11b. `assert-transport-reachable-at-boot: throws when version.json or policy.json read returns 404 (notFound)` (Round 9 — missing namespace is fatal in fail-closed-* modes)
11c. `telemetry mode: 404 on default probe path is logged + boot continues` (regression guard — fail-closed semantics do NOT leak into telemetry)
11d. `health() result includes per-path notFound: true field when 404 returned` (caller decides handling — health() itself remains transport-success-on-404 from nexus-client's pure-transport perspective)
12. `assert-transport-reachable-at-boot: does NOT await backend.ready` — only transport gate, no policy gate
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
22. `assert-transport-reachable-at-boot / assert-remote-policy-loaded-at-boot error messages include nexus error code`
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
| `nexusPermissionsEnabled` | `KOI_NEXUS_PERMISSIONS` (tri-state: `true`/`1`/`false`/`0`) | `--nexus-permissions` / `--no-nexus-permissions` (mutually exclusive) | unset → Phase 1: HTTP infers true + warns, local-bridge throws; Phase 2: throws on all transports |
| `nexusAuditEnabled` | `KOI_NEXUS_AUDIT` (tri-state: `true`/`1`/`false`/`0`) | `--nexus-audit` / `--no-nexus-audit` (mutually exclusive) | unset → Phase 1: HTTP infers true + warns, local-bridge throws; Phase 2: throws on all transports |
| `nexusAuditMode` | `KOI_NEXUS_AUDIT_MODE` (=`local-only`/`disabled`) | `--nexus-audit-mode <m>` | unset (only required for local-bridge + audit-enabled). `require` is REJECTED with actionable error — that mode was removed; local-bridge audit always skips Nexus sink |
| `nexusAuditPoisonOnError` | `KOI_NEXUS_AUDIT_POISON` (tri-state) | `--nexus-audit-poison` / `--no-nexus-audit-poison` | false |
| `nexusBootMode` | `KOI_NEXUS_BOOT_MODE` (=`telemetry`/`assert-transport-reachable-at-boot`/`assert-remote-policy-loaded-at-boot`) | `--nexus-boot-mode <m>` | `telemetry` |
| `nexusPolicyPath` | `KOI_NEXUS_POLICY_PATH` | `--nexus-policy-path <p>` | `koi/permissions` |
| `nexusSyncIntervalMs` | `KOI_NEXUS_SYNC_INTERVAL_MS` | `--nexus-sync-interval-ms <n>` | `30000` |
| `nexusBootSyncDeadlineMs` | `KOI_NEXUS_BOOT_SYNC_DEADLINE_MS` | `--nexus-boot-sync-deadline-ms <n>` | `10000` (only honored under `assert-remote-policy-loaded-at-boot`) |
| ~~`nexusProbeFactory`~~ | (REMOVED Loop 3) | (REMOVED) | runtime config no longer accepts the field; standalone probe runs are caller-site responsibility via the exported `createLocalBridgeProbeTransport` |

**Tri-state parsing:** booleans accept `true`/`1` → true, `false`/`0` → false, anything else (including unset) → undefined (which triggers the explicit-decision throw for required fields). The CLI parser rejects ambiguous combinations (e.g., both `--nexus-permissions` and `--no-nexus-permissions` on the same invocation). Existing CLI/env-driven deployments need at minimum:

```bash
# Migration one-liner (HTTP transport, both consumers active — preserves v2 behavior)
KOI_NEXUS_PERMISSIONS=true KOI_NEXUS_AUDIT=true koi up

# Audit-only deployment
KOI_NEXUS_PERMISSIONS=false KOI_NEXUS_AUDIT=true koi up

# Permissions-only (HTTP only — local-bridge throws)
KOI_NEXUS_PERMISSIONS=true KOI_NEXUS_AUDIT=false koi up
```

**Shared parser module:** parsing lives in the new `packages/meta/cli/src/nexus-config.ts` (single source of truth — see file table). Both `tui-command.ts` (interactive) AND `commands/start.ts` (headless) import `parseNexusConfigFromEnvAndFlags(env, flags)` and pass the result into `createKoiRuntime(config)`. Without this shared module the headless path silently bypasses every new safety check (`nexusBootMode`, consumer wiring, assert-*/poison contracts) — a real Loop-4-R5 finding closed by uniform wiring.

**Default-preserving rule for `commands/start.ts` (Loop 4 R9):** `nexusTransport` is constructed and threaded into `createKoiRuntime` ONLY when the operator explicitly sets `nexusPermissionsEnabled=true` OR `nexusAuditEnabled=true`. Existing headless deployments that don't set any `KOI_NEXUS_*` flags keep the pre-PR filesystem-only behavior — `koi start` does NOT construct a Nexus transport, so the HTTP-unset-flags-infer-true rule cannot trigger for them. This makes the headless rollout strictly opt-in and prevents the silent enablement that would otherwise turn legacy headless HTTP Nexus filesystem deployments into Nexus-permissions+audit deployments on upgrade.

Existing flags/env keys are unchanged. `tui-command.ts` is also responsible for the fs-only decoupling: it does NOT pass `nexusTransport` into `createKoiRuntime` when no Nexus consumer is wanted, so local-bridge sessions used purely for fs reads bypass the runtime's Nexus block entirely. `commands/start.ts` follows the same rule: when both consumer flags are explicitly false AND the manifest filesystem backend is not Nexus-backed, no `nexusTransport` is constructed.

## Migration (existing v2 deployments) — two-phase rollout

Existing v2 callers that pass `nexusTransport` already get Nexus permissions and audit wired implicitly. This PR makes both consumers explicit, but adopts a deprecation window so healthy boots are not broken on upgrade.

**Phase 1 — this PR (warn-only for unset flags on both transports; hard throw only for explicit unsafe combinations and other security gates):**

| Existing behavior | Phase 1 result | Recommended action |
|---|---|---|
| `nexusTransport` set + HTTP (no flags) | Boots; logs deprecation warning naming `nexusPermissionsEnabled`/`nexusAuditEnabled`; infers BOTH true | Set both flags explicitly to silence warning |
| `nexusTransport` + local-bridge (no flags) | THROWS at boot with actionable message naming both flags AND fs-only escape hatch ("do NOT pass nexusTransport into createKoiRuntime — see tui-command.ts decoupling"). | If fs-only: stop passing `nexusTransport` (use the local-bridge transport directly through fs-nexus path). If wiring Nexus consumers: set both flags explicitly. |
| `nexusTransport` + local-bridge + explicit `nexusPermissionsEnabled=true` | THROWS (security gate, both phases) | No migration — switch to HTTP transport |
| `nexusTransport` + local-bridge + explicit `nexusAuditEnabled=true` + no `nexusAuditMode` | THROWS (security gate) | Set `nexusAuditMode: "local-only"` (with NDJSON/SQLite) or `"disabled"` |
| `nexusTransport` + local-bridge + explicit `nexusAuditEnabled=true` without `nexusAuditMode` | THROWS (security gate) — `nexusAuditMode` required (note: "inferred" no longer reachable, since local-bridge no-flags now throws upstream) | Set `local-only` (with NDJSON/SQLite sink) or `disabled` |
| `nexusAuditPoisonOnError=true` + local-bridge | THROWS (security gate) — known wedge fault | Use HTTP for fail-stop audit |
| `nexusTransport.kind` undefined + at least one consumer flag UNSET or `true` | THROWS in both Phase 1 and Phase 2 — pre-PR semantics implicitly wired both consumers, so any path that doesn't explicitly opt out of both is an auth/audit bypass risk. | Construct via named factory (`createHttpTransport`, fs-nexus HTTP wrapper, `createLocalBridgeTransport`, `createLocalBridgeProbeTransport`). |
| `nexusTransport.kind` undefined + EXPLICIT `nexusPermissionsEnabled=false` + EXPLICIT `nexusAuditEnabled=false` | BOOTS without Nexus block (fs-only opt-out path) — the runtime skips assertProductionTransport entirely when both consumers are explicitly disabled. Legacy structural adapter passes through for non-Nexus subsystems. | This IS the migration path for legacy structural adapters that pass `nexusTransport` purely for fs-only subsystems. Set both flags explicitly to `false`; you do not need to construct via a named factory unless you also want a Nexus consumer. |

**Phase 2 — next release (separate issue, NOT this PR):**

- All transports: unset `nexusPermissionsEnabled` / `nexusAuditEnabled` → throws (currently warns + infers).
- Local-bridge + explicit `nexusPermissionsEnabled=true`: already throws in Phase 1; no change.
- `nexusTransport.kind` undefined: already throws in Phase 1; no change.
- All other security gates unchanged across phases.

The two-phase split keeps healthy v2 deployments running while giving operators and CI templates a release cycle to update. Security-relevant gates throw immediately; config-skew only warns.

### Persistent design decision: local-bridge + no-flags throws (not warn-and-infer-false)

This row in the Phase 1 table has surfaced as a recurring review concern across multiple adversarial-review rounds (recorded across two review-loop runs — 6+ occurrences). Two options were repeatedly considered:

  (A) **Throw at boot** — chosen. Atomic in-tree migration: this PR ships both `tui-command.ts` decoupling AND the throw together, so every in-tree caller is updated in lockstep. External programmatic callers using `createKoiRuntime` directly with a local-bridge transport must either (a) stop passing the transport for fs-only sessions, or (b) set both consumer flags explicitly. Failure mode is loud and actionable.

  (B) **Warn + infer false** — rejected after repeated consideration. Inferring `false` silently disables Nexus permissions/audit on local-bridge for callers that previously had implicit `true` wiring (the pre-PR behavior on local-bridge was an unsafe wedge-prone path; "preserve current behavior" preserves a known bug). Inferring `true` is also unsafe — it wires the categorically-rejected local-bridge + permissions combination, which the security gate then throws on anyway. There is no warn-only option that preserves a working configuration; current behavior on local-bridge is itself the problem this PR solves.

Decision (locked): option (A). External callers see a hard, actionable error instead of a silent authorization downgrade. The `tui-command.ts` decoupling makes the in-tree migration atomic; reviewers concerned about external callers should consult the migration table above for the explicit migration paths.

### Persistent design decision: local-bridge + Nexus permissions/audit is unsupported (no compatibility mode)

Adversarial review recurringly asks for a "compatibility mode" that preserves today's local-bridge + Nexus permissions/audit wiring. This is rejected (locked decision) because the pre-PR behavior is itself the unsafe pattern this PR exists to remove:

  - **Local-bridge + Nexus permissions** has TWO documented security failures: (a) the first policy sync can wedge the shared subprocess on `auth_required` (no protocol-level cancel exists), taking down every other Nexus consumer attached to the same session; (b) requests issued before the first sync completes authorize against the local-TUI fallback — a centralized-policy bypass that contradicts the operator's own intent in enabling Nexus permissions. Both are serious enough that earlier rounds of THIS SAME REVIEW LOOP independently called them out as security defects.
  - **Local-bridge + Nexus audit** has ONE documented security failure: a single failed audit write on `auth_required` wedges the shared subprocess, taking other Nexus consumers down with it. The local-bridge audit-mode gate (`local-only` / `disabled`) is the supported migration: skip the Nexus sink, keep working through NDJSON/SQLite (with a required-sink assertion under `local-only`).

A "preserve current behavior" compatibility mode would preserve the security defects. There is no design that simultaneously (a) keeps wiring Nexus consumers on local-bridge AND (b) avoids the auth-wedge / centralized-policy-bypass failures, because the failures are intrinsic to using a shared single-flight subprocess for security-critical reads. Operators who genuinely need Nexus permissions/audit must use HTTP transport — that is the documented migration path and there is no shortcut.

Operators who do NOT need Nexus consumers but still use local-bridge for fs reads have the documented `tui-command.ts` decoupling AND the explicit fs-only opt-out (`nexusPermissionsEnabled=false` + `nexusAuditEnabled=false`). Both work today and neither breaks pre-PR fs-only deployments. The "outage" framing in adversarial review applies only to deployments that were relying on the pre-PR unsafe wiring; those deployments need to migrate to HTTP, not preserve the bug.

Reviewers who continue to ask for a local-bridge compatibility mode should refer back to this section. Decision is locked across review loops.

## Out of scope

- gRPC client
- WebSocket transport
- Pluggable `Transport` discriminated union
- Connection pool layer
- Central typed method wrappers (`batchRead`, paths, delegation API from v1) — port these per-consumer in their own packages if/when needed
- **Audit/fs/trajectory write probes** in `health()` — would be side-effecting; data-plane failures surface on first real call (documented contract)
- **Server-side dedicated `health` RPC** — Nexus server change; future work
- **Coordinated runtime shutdown API (`requestShutdown`)** — currently the runtime exposes only `shutdownBackgroundTasks()` (synchronous, fire-and-forget). A first-class coordinated-shutdown primitive that stops admission, flushes local audit sinks, closes channels/MCP servers/transports, and exits cleanly is required to honor a synchronous hard-exit guarantee for Nexus compliance failures. Tracked separately; until it lands, this PR's `nexusAuditPoisonOnError: true` mode terminates new admission via the latch and rejects post-poison sink writes via the wrapper, but does NOT abort the in-flight session.

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
