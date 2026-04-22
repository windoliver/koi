/**
 * Permissions middleware — sole interposition layer for tool-level access control.
 *
 * Two interception points:
 * - wrapModelCall: batch-checks all tools, filters denied ones from LLM context
 * - wrapToolCall: re-checks at invocation, handles ask → approval flow
 *
 * Supports decision caching, approval caching, audit logging, circuit breaker,
 * and denial tracking.
 */

import { createSpecRegistry } from "@koi/bash-ast";
import { canonicalPrefix, classifyCommand, UNSAFE_PREFIX } from "@koi/bash-classifier";
import type { AuditEntry, AuditSink } from "@koi/core";
import type { JsonObject } from "@koi/core/common";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type { PermissionDecision, PermissionQuery } from "@koi/core/permission-backend";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import { type CircuitBreaker, createCircuitBreaker, swallowError } from "@koi/errors";
import { computeStringHash } from "@koi/hash";
import { createApprovalAudit } from "./approval-audit.js";
// fnv1a no longer used for cache keys (collision-unsafe for security decisions)
import { isDefaultDeny } from "./classifier.js";
import type { PermissionsMiddlewareConfig } from "./config.js";
import {
  DEFAULT_APPROVAL_CACHE_MAX_ENTRIES,
  DEFAULT_APPROVAL_CACHE_TTL_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  DEFAULT_CACHE_CONFIG,
  DEFAULT_DENIAL_ESCALATION_THRESHOLD,
  DEFAULT_DENIAL_ESCALATION_WINDOW_MS,
} from "./config.js";
import { createDenialTracker, type DenialTracker } from "./denial-tracker.js";
import { createFilterTools } from "./filter-tools.js";
import { createHandleAskDecision } from "./handle-ask-decision.js";
import {
  buildPrincipal,
  computeApprovalCacheKey,
  createApprovalCache,
  createDecisionCache,
  decisionCacheKey,
  serializeTurnContext,
  VALID_ALWAYS_ALLOW_SCOPES,
  VALID_APPROVAL_KINDS,
  VALID_EFFECTS,
} from "./middleware-internals.js";
import { createBatchResolver } from "./resolve-batch.js";
import { createSoftDenyLog, type SoftDenyLog } from "./soft-deny-log.js";
import { createTurnSoftDenyCounter, type TurnSoftDenyCounter } from "./turn-soft-deny-counter.js";
import { createWrapToolCall } from "./wrap-tool-call.js";

// ---------------------------------------------------------------------------
// Re-exported internals (for tests / consumers that import these symbols)
// ---------------------------------------------------------------------------

// VALID_EFFECTS, VALID_APPROVAL_KINDS, VALID_ALWAYS_ALLOW_SCOPES are used in tests
export { VALID_ALWAYS_ALLOW_SCOPES, VALID_APPROVAL_KINDS, VALID_EFFECTS };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const PKG = "@koi/middleware-permissions";

/**
 * Extended middleware returned by {@link createPermissionsMiddleware}.
 *
 * This IS a KoiMiddleware (backward compatible — can be passed directly
 * into `middleware: [...]`) with additional methods for runtime wiring.
 */
export interface PermissionsMiddlewareHandle extends KoiMiddleware {
  /**
   * Register an additional approval-step sink.  The runtime calls this
   * with a dispatch relay that routes to the correct per-stream
   * `EventTraceHandle.emitExternalStep` by sessionId.
   * Additive: multiple sinks can coexist (multi-runtime safe).
   * Returns an unsubscribe function to remove the sink on runtime disposal.
   */
  readonly setApprovalStepSink: (
    sink: (sessionId: string, step: RichTrajectoryStep) => void,
  ) => () => void;
  /**
   * Clear all session-scoped approval state (always-allow grants, decision
   * caches, approval caches, denial trackers) for the given session ID.
   *
   * Call on `agent:clear` / `session:new` so prior-session approvals do not
   * silently carry over into the next conversation.
   */
  readonly clearSessionApprovals: (sessionId: string) => void;
  /**
   * Revoke a persistent always-allow grant by its exact stored key.
   * Returns true if a grant existed. No-op if no persistent store is
   * configured.
   *
   * `grantKey` must match the key the grant was stored under. For bash
   * tools with `resolveBashCommand` configured, grants are stored under
   * `<toolId>:<prefix>:<16hex>` (exact-command hash). Callers can obtain
   * the correct key in two ways:
   *   1. `listPersistentApprovals()` — iterate stored grants.
   *   2. `computeBashGrantKey(toolId, command)` — derive the key from
   *      the raw command string, matching how the middleware stored it.
   *
   * For non-bash tools, `grantKey` is the plain tool id.
   */
  readonly revokePersistentApproval: (userId: string, agentId: string, grantKey: string) => boolean;
  /**
   * Derive the persistent grant key for a given bash tool invocation.
   * Mirrors the internal hashing used when the middleware records a
   * grant so callers can reliably construct the key that
   * `revokePersistentApproval` expects.
   *
   * Returns the plain `toolId` when `resolveBashCommand` is not
   * configured, or when the raw command is empty.
   */
  readonly computeBashGrantKey: (toolId: string, rawCommand: string, context?: string) => string;
  /**
   * Revoke all persistent always-allow grants.
   * No-op if no persistent store is configured.
   */
  readonly revokeAllPersistentApprovals: () => void;
  /**
   * List all persistent always-allow grants (for UI/diagnostics).
   * Returns empty array if no persistent store is configured.
   */
  readonly listPersistentApprovals: () => readonly import("./approval-store.js").ApprovalGrant[];
}

export function createPermissionsMiddleware(
  config: PermissionsMiddlewareConfig,
): PermissionsMiddlewareHandle {
  const {
    backend,
    auditSink,
    description,
    persistentApprovals: persistentStore,
    persistentAgentId,
  } = config;

  // Bash enrichment requires a backend that can distinguish default-deny
  // from explicit deny so the dual-key merge doesn't silently hard-deny
  // enriched bash calls via unmarked fall-through denies. The capability
  // is part of the public `PermissionBackend` contract
  // (`supportsDefaultDenyMarker`).
  //
  // Policy:
  //  - Marker-aware backend → dual-key evaluation, prefix rules enforced.
  //  - Legacy backend + no opt-in → fail closed at construction.
  //    Preserves policy integrity; operator gets an immediate, clear
  //    error instead of a silent downgrade or runtime surprise.
  //  - Legacy backend + `allowLegacyBackendBashFallback: true` →
  //    explicit opt-in to single-key evaluation. Operator has
  //    acknowledged that prefix rules will not apply; middleware
  //    still logs a warning so the weaker enforcement is visible.
  const backendSupportsDualKey = config.backend.supportsDefaultDenyMarker === true;
  if (config.resolveBashCommand !== undefined && !backendSupportsDualKey) {
    if (config.allowLegacyBackendBashFallback !== true) {
      throw new Error(
        "createPermissionsMiddleware: `resolveBashCommand` requires a " +
          "PermissionBackend with `supportsDefaultDenyMarker: true`. Without " +
          "the marker, prefix rules like `allow: bash:git push` cannot be " +
          "enforced — enabling dual-key evaluation anyway would silently " +
          "hard-deny via unmarked fall-through denies. To mark your backend, " +
          "set fall-through denies with the `IS_DEFAULT_DENY` symbol " +
          "(exported from @koi/middleware-permissions) or a public " +
          "`default: true` field, then set `supportsDefaultDenyMarker: true` " +
          "on the backend object. To opt into single-key evaluation anyway " +
          "(prefix rules will NOT be enforced), set " +
          "`allowLegacyBackendBashFallback: true`.",
      );
    }
    console.warn(
      "[@koi/middleware-permissions] `resolveBashCommand` is configured but " +
        "the backend does not set `supportsDefaultDenyMarker: true`. Running " +
        "in single-key fallback mode (allowLegacyBackendBashFallback=true). " +
        "Prefix rules like `allow: bash:git push` WILL NOT be enforced — only " +
        "plain-tool-id rules apply. Mark your backend to enable full dual-key " +
        "enrichment.",
    );
  }
  const originalSink = config.onApprovalStep;
  // Additive runtime sinks — each createRuntime registers its own dispatch relay.
  // Using an array allows a single permissions handle to be shared across runtimes.
  const runtimeSinks: ((sessionId: string, step: RichTrajectoryStep) => void)[] = [];

  /** Fan-out: calls the original onApprovalStep and all runtime-bound sinks.
   *  Each sink is isolated — a throw in one cannot suppress another. */
  function approvalSink(sessionId: string, step: RichTrajectoryStep): void {
    if (originalSink !== undefined) {
      try {
        originalSink(sessionId, step);
      } catch (e: unknown) {
        swallowError(e, { package: PKG, operation: "approval-step-original" });
      }
    }
    for (const sink of runtimeSinks) {
      try {
        sink(sessionId, step);
      } catch (e: unknown) {
        swallowError(e, { package: PKG, operation: "approval-step-runtime" });
      }
    }
  }
  const clock = config.clock ?? Date.now;
  const approvalTimeoutMs = config.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;

  // Circuit breaker (optional)
  const cb: CircuitBreaker | undefined =
    config.circuitBreaker !== undefined
      ? createCircuitBreaker(config.circuitBreaker, clock)
      : undefined;

  // Per-session decision caches (created on demand, dropped on session end)
  const cacheConfig =
    config.cache !== undefined && config.cache !== false
      ? typeof config.cache === "object"
        ? config.cache
        : DEFAULT_CACHE_CONFIG
      : undefined;
  const decisionCachesBySession = new Map<string, ReturnType<typeof createDecisionCache>>();

  function getDecisionCache(sessionId: string): ReturnType<typeof createDecisionCache> | undefined {
    if (cacheConfig === undefined) return undefined;
    let c = decisionCachesBySession.get(sessionId);
    if (c === undefined) {
      c = createDecisionCache(cacheConfig, clock);
      decisionCachesBySession.set(sessionId, c);
    }
    return c;
  }

  // Per-session approval caches (created on demand, dropped on session end)
  const approvalCacheConfig =
    config.approvalCache !== undefined && config.approvalCache !== false
      ? typeof config.approvalCache === "object"
        ? config.approvalCache
        : { ttlMs: DEFAULT_APPROVAL_CACHE_TTL_MS, maxEntries: DEFAULT_APPROVAL_CACHE_MAX_ENTRIES }
      : undefined;
  const approvalCachesBySession = new Map<string, ReturnType<typeof createApprovalCache>>();

  // Per-session always-allowed tool IDs (from "always-allow" approval decisions).
  // When a tool is in this set, future calls skip the approval handler entirely.
  //
  // SECURITY NOTE: This is a per-tool bypass — approving "bash" once approves ALL
  // future bash calls in the session regardless of arguments. This is intentional and
  // matches Claude Code's "a" key behavior: the user explicitly opts into blanket
  // tool approval. The tradeoff (convenience vs re-prompting on risky args) is
  // accepted because:
  //   1. The user made an explicit "always" decision (not a default)
  //   2. Every bypass is audit-logged via the denial tracker
  //   3. Session scope limits blast radius (cleared on session end)
  //
  // Future mitigation: a riskReclassifier callback that re-evaluates always-allowed
  // calls and revokes the bypass when input risk exceeds a threshold.
  const alwaysAllowedBySession = new Map<string, Set<string>>();

  function getApprovalCache(sessionId: string): ReturnType<typeof createApprovalCache> | undefined {
    if (approvalCacheConfig === undefined) return undefined;
    let c = approvalCachesBySession.get(sessionId);
    if (c === undefined) {
      c = createApprovalCache(approvalCacheConfig, clock);
      approvalCachesBySession.set(sessionId, c);
    }
    return c;
  }

  // Backend fingerprint for approval cache key isolation (random string per instance)
  const backendFingerprint = String(Math.random());

  // In-flight approval deduplication: concurrent identical ask calls
  // coalesce onto a single pending approval instead of double-prompting
  const inflightApprovals = new Map<string, Promise<unknown>>();

  // Per-session index of in-flight dedup keys — used by clearSessionApprovals
  // to evict all pending approvals for a session on agent:clear / session:new.
  // Without this, a stale dialog approval can still resolve and re-populate
  // the approval cache for what the user expects to be a fresh session.
  const inflightKeysBySession = new Map<string, Set<string>>();

  // Denial trackers scoped per session (keyed by sessionId)
  const trackersBySession = new Map<string, DenialTracker>();

  function getTracker(sessionId: string): DenialTracker {
    let t = trackersBySession.get(sessionId);
    if (t === undefined) {
      t = createDenialTracker();
      trackersBySession.set(sessionId, t);
    }
    return t;
  }

  // Soft-deny logs scoped per session (#1650)
  const softDenyLogsBySession = new Map<string, SoftDenyLog>();

  function getSoftDenyLog(sessionId: string): SoftDenyLog {
    let log = softDenyLogsBySession.get(sessionId);
    if (log === undefined) {
      log = createSoftDenyLog();
      softDenyLogsBySession.set(sessionId, log);
    }
    return log;
  }

  // Per-turn soft-deny counters scoped per session (#1650)
  const turnSoftDenyCountersBySession = new Map<string, TurnSoftDenyCounter>();

  function getTurnSoftDenyCounter(sessionId: string): TurnSoftDenyCounter {
    let counter = turnSoftDenyCountersBySession.get(sessionId);
    if (counter === undefined) {
      counter = createTurnSoftDenyCounter();
      turnSoftDenyCountersBySession.set(sessionId, counter);
    }
    return counter;
  }

  // Planning-time cap-exhaustion recording dedup (#1650 loop round-3).
  // Key: `${sessionId}\0${turnIndex}\0${cacheKey}`. Ensures DenialTracker is
  // written to at most ONCE per (session, turn, cacheKey) when filterTools
  // strips a tool because its per-turn soft-deny budget is exhausted.
  // Without this, repeated planning passes in the same turn would evict
  // native hard-deny history from the bounded-FIFO tracker.
  const filterCapRecordedKeys = new Set<string>();

  // Denial escalation config
  const escalationEnabled =
    config.denialEscalation !== undefined && config.denialEscalation !== false;
  const escalationThreshold = escalationEnabled
    ? typeof config.denialEscalation === "object"
      ? (config.denialEscalation.threshold ?? DEFAULT_DENIAL_ESCALATION_THRESHOLD)
      : DEFAULT_DENIAL_ESCALATION_THRESHOLD
    : Infinity;
  const escalationWindowMs = escalationEnabled
    ? typeof config.denialEscalation === "object"
      ? (config.denialEscalation.windowMs ?? DEFAULT_DENIAL_ESCALATION_WINDOW_MS)
      : DEFAULT_DENIAL_ESCALATION_WINDOW_MS
    : 0;

  // Forged-tool default-deny bypass removed (v2): forged tools must be
  // explicitly allowed via backend rules. Name-based bypasses are unsafe
  // because tool identity can change between model filtering and execution.

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Backend-tolerant default-deny check. Recognizes both the
   * built-in pattern backend's internal symbol marker and a public
   * `default: true` field that custom backends can set on their
   * fall-through denies. Custom backends that set neither are
   * treated as explicit deny (backward compat with backends that
   * have no notion of default-deny — their denies ARE authoritative).
   */
  function isDefaultDenyLike(d: PermissionDecision): boolean {
    if (d.effect !== "deny") return false;
    if (isDefaultDeny(d)) return true;
    const withFlag = d as Record<string, unknown>;
    return withFlag.default === true || withFlag.defaultDeny === true;
  }

  function strictestDecision(
    plain: PermissionDecision,
    enriched: PermissionDecision,
  ): PermissionDecision {
    const plainOpinion = !(plain.effect === "deny" && isDefaultDenyLike(plain));
    const enrichedOpinion = !(enriched.effect === "deny" && isDefaultDenyLike(enriched));

    // Neither side opined — fall-through deny from either is fine.
    if (!plainOpinion && !enrichedOpinion) return plain;
    // Only one side opined — use it.
    if (!plainOpinion) return enriched;
    if (!enrichedOpinion) return plain;

    // Both explicit: deny beats ask beats allow.
    if (plain.effect === "deny") return plain;
    if (enriched.effect === "deny") return enriched;
    if (plain.effect === "ask") return plain;
    if (enriched.effect === "ask") return enriched;
    return plain;
  }

  function deriveBashKeys(
    toolId: string,
    rawCommand: string,
    context?: string,
  ): { readonly policy: string; readonly grant: string } | null {
    const trimmed = rawCommand.trim();
    if (trimmed.length === 0) return null;
    const p = canonicalPrefix(trimmed);
    if (p.length === 0) return null;
    const danger = classifyCommand(trimmed);
    const dangerous = danger.severity === "critical" || danger.severity === "high";
    // Hash covers the execution context (cwd / repo root / tenant)
    // in addition to the command text. Without context-binding,
    // approving `git push` in one repo silently authorizes the same
    // text in a different repo/checkout/tenant. When the caller
    // cannot supply stable context (undefined), hash degrades to
    // command-only scope — documented as a caveat for deployments
    // where approvals MUST be context-scoped.
    const hashInput = context !== undefined ? `${context}\0${trimmed}` : trimmed;
    const hash = computeStringHash(hashInput).slice(0, 16);
    // POLICY key for `!complex` is stable (no hash) so denial
    // tracking and soft-deny escalation aggregate across distinct
    // compound commands. An agent spamming different `bash -c` /
    // pipeline / redirection variants hits the same bucket and
    // trips the per-session retry cap predictably.
    const policy = p === UNSAFE_PREFIX ? `${toolId}:${UNSAFE_PREFIX}` : `${toolId}:${p}`;
    // GRANT key: always includes the hash, and escalates to `!complex`
    // for dangerous forms so an approval for `python -c "print(1)"`
    // does NOT cover a later `python -c "os.system('rm')"`. Same
    // deterministic discriminator as policy for structurally complex
    // commands.
    const grantPrefix = p === UNSAFE_PREFIX || dangerous ? UNSAFE_PREFIX : p;
    const grant = `${toolId}:${grantPrefix}:${hash}`;
    return { policy, grant };
  }

  /**
   * Compute two distinct resource keys for a tool call:
   *
   *   `policy`  — `<toolId>:<prefix>` for non-`!complex` commands, or
   *               `<toolId>:!complex:<hash>` for complex/dangerous forms.
   *               Used for backend rule matching and denial-tracker
   *               escalation.
   *   `grant`   — `<toolId>:<effectivePrefix>:<hash>` (always includes
   *               an exact-command hash). Used for session and
   *               persistent `always-allow` grants and approval audit.
   *
   * When `resolveBashCommand` is unconfigured or returns nothing, both
   * keys fall back to the plain tool id.
   */
  function enrichResource(
    toolId: string,
    input: JsonObject | undefined,
  ): { readonly policy: string; readonly grant: string } {
    if (config.resolveBashCommand === undefined || input === undefined) {
      return { policy: toolId, grant: toolId };
    }
    const raw = config.resolveBashCommand(toolId, input);
    if (raw === undefined) return { policy: toolId, grant: toolId };
    const execContext = config.resolveBashContext?.(toolId, input);
    const derived = deriveBashKeys(toolId, raw, execContext);
    return derived ?? { policy: toolId, grant: toolId };
  }

  function queryForTool(
    ctx: TurnContext,
    resource: string,
    requestMetadata?: JsonObject,
    resolvedPath?: string,
  ): PermissionQuery {
    // Build principal with user/session scope for tenant isolation.
    // Uses JSON array encoding to prevent separator collisions.
    const userId = ctx.session.userId ?? "__anonymous__";
    const sessionId = ctx.session.sessionId as string;
    const principal = buildPrincipal(ctx.session.agentId, userId, sessionId);

    // Merge session + turn + per-request metadata into query context.
    // All three layers participate in backend checks and cache keys.
    const sessionMeta = ctx.session.metadata;
    const turnMeta = ctx.metadata;
    const hasSessionMeta = Object.keys(sessionMeta).length > 0;
    const hasTurnMeta = Object.keys(turnMeta).length > 0;
    const hasReqMeta = requestMetadata !== undefined && Object.keys(requestMetadata).length > 0;
    const hasPath = resolvedPath !== undefined;
    if (hasSessionMeta || hasTurnMeta || hasReqMeta || hasPath) {
      const merged = {
        ...(hasSessionMeta ? { _session: sessionMeta } : {}),
        ...(hasTurnMeta ? turnMeta : {}),
        ...(hasReqMeta ? { _request: requestMetadata } : {}),
        ...(hasPath ? { path: resolvedPath } : {}),
      };
      return { principal, action: "invoke", resource, context: merged };
    }
    return { principal, action: "invoke", resource };
  }

  /** Audit a permission decision at execution time (wrapToolCall). */
  function auditDecision(
    ctx: TurnContext,
    resource: string,
    decision: PermissionDecision,
    durationMs: number,
    sink: AuditSink,
  ): void {
    const entry: AuditEntry = {
      schema_version: 2,
      timestamp: clock(),
      sessionId: ctx.session.sessionId as string,
      agentId: ctx.session.agentId,
      turnIndex: ctx.turnIndex,
      kind: "permission_decision",
      durationMs,
      metadata: {
        permissionCheck: true,
        permissionEvent:
          decision.effect === "ask" ? "asked" : decision.effect === "deny" ? "denied" : "granted",
        phase: "execute",
        resource,
        effect: decision.effect,
        userId: ctx.session.userId ?? "__anonymous__",
        ...(decision.effect !== "allow" ? { reason: decision.reason } : {}),
      },
    };
    void sink.log(entry).catch((e: unknown) => {
      swallowError(e, { package: PKG, operation: "audit" });
    });
  }

  // Wire up approval audit helpers via factory
  const { auditApprovalOutcome, emitApprovalStep } = createApprovalAudit({
    clock,
    approvalSink,
  });

  // Wire up batch resolver (resolveDecision + resolveBatch) via factory
  const { resolveDecision, resolveBatch } = createBatchResolver({
    backend,
    cb,
    getDecisionCache,
    escalationEnabled,
    escalationThreshold,
    escalationWindowMs,
    clock,
    getTracker,
    decisionCacheKey,
  });

  // Wire up filterTools via factory
  const { filterTools } = createFilterTools({
    config,
    auditSink,
    clock,
    filterCapRecordedKeys,
    getTracker,
    getTurnSoftDenyCounter,
    getSoftDenyLog,
    isDefaultDenyLike,
    queryForTool,
    resolveBatch,
  });

  // Wire up handleAskDecision via factory
  const { handleAskDecision } = createHandleAskDecision({
    config,
    auditSink,
    clock,
    approvalTimeoutMs,
    persistentStore,
    persistentAgentId,
    backendFingerprint,
    inflightApprovals,
    inflightKeysBySession,
    alwaysAllowedBySession,
    getTracker,
    getApprovalCache,
    emitApprovalStep,
    auditApprovalOutcome,
    computeApprovalCacheKey,
    serializeTurnContext,
  });

  // Spec guard: enabled when resolveBashCommand is configured and
  // enableBashSpecGuard is not explicitly set to false.
  const specRegistry = createSpecRegistry();
  const specGuardEnabled =
    config.resolveBashCommand !== undefined && config.enableBashSpecGuard !== false;

  // Wire up wrapToolCall via factory
  const { wrapToolCall } = createWrapToolCall({
    config,
    auditSink,
    clock,
    backendSupportsDualKey,
    enrichResource,
    queryForTool,
    resolveDecision,
    strictestDecision,
    auditDecision,
    getTracker,
    getTurnSoftDenyCounter,
    getSoftDenyLog,
    handleAskDecision,
    specRegistry,
    specGuardEnabled,
  });

  // -----------------------------------------------------------------------
  // Middleware + Handle
  // -----------------------------------------------------------------------

  function clearSessionApprovals(sessionId: string): void {
    // Mirror the cleanup performed by onSessionEnd, but callable externally
    // so the TUI runtime can clear per-session state on agent:clear / session:new
    // without disposing the runtime (which would call onSessionEnd internally).
    const sid = sessionId;
    trackersBySession.get(sid)?.clear();
    trackersBySession.delete(sid);
    decisionCachesBySession.get(sid)?.clear();
    decisionCachesBySession.delete(sid);
    approvalCachesBySession.get(sid)?.clear();
    approvalCachesBySession.delete(sid);
    alwaysAllowedBySession.delete(sid);
    // #1650: evict soft-deny session state so a reused session id does not
    // inherit the previous turn's counter or soft-deny log.
    softDenyLogsBySession.get(sid)?.clear();
    softDenyLogsBySession.delete(sid);
    turnSoftDenyCountersBySession.get(sid)?.clear();
    turnSoftDenyCountersBySession.delete(sid);
    for (const key of filterCapRecordedKeys) {
      if (key.startsWith(`${sid}\0`)) filterCapRecordedKeys.delete(key);
    }
    // Evict all in-flight approval coalesce entries for this session so that
    // a stale dialog approval resolved after reset cannot re-populate the cache
    // or cause new callers to coalesce onto an old pending promise.
    // Note: the underlying approvalHandler promise itself is not cancellable here
    // (that requires disposing the permissionBridge), but removing the dedup entry
    // prevents any new callers from inheriting the stale approval decision.
    const keys = inflightKeysBySession.get(sid);
    if (keys !== undefined) {
      for (const key of keys) {
        inflightApprovals.delete(key);
      }
      inflightKeysBySession.delete(sid);
    }
  }

  const middleware: KoiMiddleware = {
    name: "permissions",
    priority: 100,
    phase: "intercept",

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return {
        label: "permissions",
        description: description ?? "Permission checks enabled",
      };
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      // Clear only this session's state — not other active sessions.
      // Backend is NOT disposed here: it is shared across sessions and
      // owned by the middleware instance, not by any individual session.
      const sid = ctx.sessionId as string;
      trackersBySession.get(sid)?.clear();
      trackersBySession.delete(sid);
      decisionCachesBySession.get(sid)?.clear();
      decisionCachesBySession.delete(sid);
      approvalCachesBySession.get(sid)?.clear();
      approvalCachesBySession.delete(sid);
      alwaysAllowedBySession.delete(sid);
      // #1650: evict soft-deny session state so long-lived runtimes do not
      // retain per-session log/counter objects after session teardown.
      softDenyLogsBySession.get(sid)?.clear();
      softDenyLogsBySession.delete(sid);
      turnSoftDenyCountersBySession.get(sid)?.clear();
      turnSoftDenyCountersBySession.delete(sid);
      for (const key of filterCapRecordedKeys) {
        if (key.startsWith(`${sid}\0`)) filterCapRecordedKeys.delete(key);
      }
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const filtered = await filterTools(ctx, request);
      return next(filtered);
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<never> {
      const filtered = await filterTools(ctx, request);
      yield* next(filtered) as AsyncIterable<never>;
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      return wrapToolCall(ctx, request, next);
    },

    async onBeforeTurn(_ctx: TurnContext): Promise<void> {
      // #1650 loop round-5/loop-2 round-1: counter keys are already
      // turn-scoped via `${turnIndex}\0${cacheKey}` prefix, so they don't
      // collide across turns. Intentionally NO reaping here — reaping
      // older turns by relative distance would wipe the budget of a
      // long-running/stalled turn that has since been overtaken by newer
      // turns, letting a late tool call from the older turn accrue a fresh
      // cap. Memory bound comes from:
      //   - The counter's fail-closed ceiling (see turn-soft-deny-counter.ts)
      //   - clearSessionApprovals / onSessionEnd, which evict the whole map
      // filterCapRecordedKeys is similarly retained until session end.
    },
  };

  return Object.assign(middleware, {
    setApprovalStepSink(sink: (sessionId: string, step: RichTrajectoryStep) => void): () => void {
      runtimeSinks.push(sink);
      return () => {
        const idx = runtimeSinks.indexOf(sink);
        if (idx >= 0) runtimeSinks.splice(idx, 1);
      };
    },
    clearSessionApprovals,
    revokePersistentApproval(userId: string, agentId: string, grantKey: string): boolean {
      if (persistentStore === undefined) return false;
      // `grantKey` must match the exact-command key that was stored
      // (`<toolId>:<prefix>:<16hex>` when bash enrichment is on). Use
      // `computeBashGrantKey` or `listPersistentApprovals` to derive it.
      // Removes the durable row only. Active sessions retain their own
      // session-scoped bypass until session end — the in-memory set does
      // not encode user identity or grant source, so clearing it would
      // break unrelated session-only approvals.
      return persistentStore.revoke(userId, agentId, grantKey);
    },
    computeBashGrantKey(toolId: string, rawCommand: string, context?: string): string {
      // Shares the exact key-derivation helper with enrichResource so
      // that dangerous-pattern escalation, `!complex` remapping, and
      // context-scoping are applied identically. Callers that need to
      // revoke context-scoped grants must supply the same `context`
      // value the middleware used when storing the grant (typically
      // the return value of `resolveBashContext` for the active turn).
      if (config.resolveBashCommand === undefined) return toolId;
      const derived = deriveBashKeys(toolId, rawCommand, context);
      return derived?.grant ?? toolId;
    },
    revokeAllPersistentApprovals(): void {
      // Same rationale: only clear durable state. Session-scoped grants
      // remain until the session ends or clearSessionApprovals() is called.
      persistentStore?.revokeAll();
    },
    listPersistentApprovals(): readonly import("./approval-store.js").ApprovalGrant[] {
      if (persistentStore === undefined) return [];
      return persistentStore.list();
    },
    // Internal test hooks — NOT part of the public API surface.
    // Used only in unit tests to inspect per-session state that cannot be
    // observed through the public interface without adding new public API.
    __getSoftDenyLogForTesting(sessionId: string): SoftDenyLog {
      return getSoftDenyLog(sessionId);
    },
    __getDenialTrackerForTesting(sessionId: string): DenialTracker {
      return getTracker(sessionId);
    },
  }) as PermissionsMiddlewareHandle;
}
