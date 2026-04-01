/**
 * DelegationManager — unified coordinator for the delegation lifecycle.
 *
 * Owns the grant store, binds to agent lifecycle (via AgentRegistry.watch()),
 * manages per-delegatee circuit breakers, and emits typed events.
 *
 * This is an L2 package — imports only from @koi/core (L0) and L0u utilities.
 */

import type {
  AgentId,
  AgentRegistry,
  DelegationEvent,
  DelegationGrant,
  DelegationId,
  DelegationManagerConfig,
  DelegationScope,
  DelegationVerifyResult,
  KoiError,
  PermissionBackend,
  PermissionDecision,
  RegistryEvent,
  Result,
  RevocationRegistry,
  ScopeChecker,
} from "@koi/core";
import type { CircuitState } from "./circuit-breaker.js";
import { createCircuitBreaker } from "./circuit-breaker.js";
import { attenuateGrant, createGrant } from "./grant.js";
import { createGrantIndex, createInMemoryRegistry } from "./registry.js";
import { revokeGrant } from "./revoke.js";
import { verifyGrant } from "./verify.js";
import { createVerifyCache } from "./verify-cache.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface CreateDelegationManagerParams {
  readonly config: DelegationManagerConfig;
  readonly registry?: AgentRegistry;
  readonly revocationRegistry?: RevocationRegistry;
  readonly scopeChecker?: ScopeChecker;
  readonly onEvent?: (event: DelegationEvent) => void;
  /** Called after a grant is stored. Throw to roll back the grant. */
  readonly onGrant?: (grant: DelegationGrant) => void | Promise<void>;
  /** Called after a revocation completes. Best-effort — failures are logged, not re-thrown. */
  readonly onRevoke?: (grantId: DelegationId, cascade: boolean) => void | Promise<void>;
  /** Optional permission backend for escalation prevention at grant-time. */
  readonly permissionBackend?: PermissionBackend;
  /** Optional session resolver for session-scoped grant verification. */
  readonly getActiveSessions?: () => ReadonlySet<string> | Promise<ReadonlySet<string>>;
}

export interface DelegationManager {
  // Grant lifecycle
  readonly grant: (
    issuerId: AgentId,
    delegateeId: AgentId,
    scope: DelegationScope,
    ttlMs?: number,
  ) => Promise<Result<DelegationGrant, KoiError>>;
  readonly attenuate: (
    parentId: DelegationId,
    delegateeId: AgentId,
    scope: DelegationScope,
    ttlMs?: number,
  ) => Promise<Result<DelegationGrant, KoiError>>;
  readonly revoke: (id: DelegationId, cascade?: boolean) => Promise<readonly DelegationId[]>;
  readonly verify: (grantId: DelegationId, toolId: string) => Promise<DelegationVerifyResult>;
  readonly list: (agentId?: AgentId) => readonly DelegationGrant[];

  // Circuit breaker
  readonly recordSuccess: (delegateeId: AgentId) => void;
  readonly recordFailure: (delegateeId: AgentId) => void;
  readonly canDelegate: (delegateeId: AgentId) => boolean;
  readonly circuitState: (delegateeId: AgentId) => CircuitState;
  readonly isExhausted: (delegateeIds: readonly AgentId[]) => boolean;

  // Cleanup
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDelegationManager(params: CreateDelegationManagerParams): DelegationManager {
  const {
    config,
    scopeChecker,
    onEvent,
    onGrant: onGrantHook,
    onRevoke: onRevokeHook,
    permissionBackend,
    getActiveSessions,
  } = params;

  // Internal state — single source of truth
  const grantStore = new Map<DelegationId, DelegationGrant>();
  const grantIndex = createGrantIndex();
  const circuitBreaker = createCircuitBreaker(config.circuitBreaker);
  const verifyCache = createVerifyCache();

  // Default revocation registry — in-memory, no timer start until first revoke
  const inMemoryReg =
    params.revocationRegistry === undefined ? createInMemoryRegistry() : undefined;
  const revocationRegistry: RevocationRegistry =
    params.revocationRegistry ?? inMemoryReg ?? createInMemoryRegistry();

  // Track previous circuit states for event emission
  const prevCircuitStates = new Map<AgentId, CircuitState>();

  function emit(event: DelegationEvent): void {
    onEvent?.(event);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle binding — subscribe to AgentRegistry events
  // ---------------------------------------------------------------------------

  let registryUnsubscribe: (() => void) | undefined;

  if (params.registry !== undefined) {
    registryUnsubscribe = params.registry.watch((event: RegistryEvent) => {
      if (event.kind === "transitioned" && event.to === "terminated") {
        void revokeGrantsForAgent(event.agentId);
      } else if (event.kind === "deregistered") {
        void revokeGrantsForAgent(event.agentId);
      }
    });
  }

  async function revokeGrantsForAgent(agentId: AgentId): Promise<void> {
    // Find all grants issued BY this agent
    const grantsToRevoke = [...grantStore.values()].filter((g) => g.issuerId === agentId);

    for (const g of grantsToRevoke) {
      await revokeInternal(g.id, true);
    }
  }

  // ---------------------------------------------------------------------------
  // Escalation prevention
  // ---------------------------------------------------------------------------

  /**
   * Checks that the grantor actually holds all permissions being delegated.
   * Batch check first, fail-fast sequential fallback.
   * Fail-closed: any backend error → deny.
   */
  async function checkEscalation(
    grantorId: AgentId,
    scope: DelegationScope,
  ): Promise<Result<void, KoiError>> {
    if (permissionBackend === undefined) {
      return { ok: true, value: undefined };
    }

    const permissions = scope.permissions.allow ?? [];
    if (permissions.length === 0) {
      return { ok: true, value: undefined };
    }

    const resources = scope.resources ?? [`delegation:${grantorId}`];
    const queries = permissions.flatMap((action) =>
      resources.map((resource) => ({
        principal: `agent:${grantorId}`,
        action,
        resource,
      })),
    );

    try {
      // Prefer batch check when available
      if (permissionBackend.checkBatch !== undefined) {
        const decisions = await permissionBackend.checkBatch(queries);
        const denied = decisions.find((d: PermissionDecision) => d.effect !== "allow");
        if (denied !== undefined) {
          return {
            ok: false,
            error: {
              code: "PERMISSION",
              message: `Escalation denied: grantor lacks delegated permission${denied.effect === "deny" ? ` — ${denied.reason}` : ""}`,
              retryable: false,
              context: { grantorId },
            },
          };
        }
        return { ok: true, value: undefined };
      }

      // Fall back to fail-fast sequential checks
      for (const query of queries) {
        const decision = await permissionBackend.check(query);
        if (decision.effect !== "allow") {
          return {
            ok: false,
            error: {
              code: "PERMISSION",
              message: `Escalation denied: grantor lacks permission "${query.action}" on "${query.resource}"${decision.effect === "deny" ? ` — ${decision.reason}` : ""}`,
              retryable: false,
              context: { grantorId, action: query.action, resource: query.resource },
            },
          };
        }
      }

      return { ok: true, value: undefined };
    } catch (e: unknown) {
      // Fail-closed: backend error → deny
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `Escalation check failed (fail-closed): ${e instanceof Error ? e.message : String(e)}`,
          retryable: true,
          context: { grantorId },
        },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Grant lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Store a grant, emit the event, and fire the onGrant hook.
   * Rolls back store + index on hook failure.
   */
  async function storeGrantAndNotify(grantResult: DelegationGrant): Promise<void> {
    grantStore.set(grantResult.id, grantResult);
    grantIndex.addGrant(grantResult);

    emit({ kind: "delegation:granted", grant: grantResult });

    if (onGrantHook !== undefined) {
      try {
        await onGrantHook(grantResult);
      } catch (hookError: unknown) {
        grantStore.delete(grantResult.id);
        grantIndex.removeGrant(grantResult);
        throw new Error("onGrant hook failed — grant rolled back", { cause: hookError });
      }
    }
  }

  async function grant(
    issuerId: AgentId,
    delegateeId: AgentId,
    scope: DelegationScope,
    ttlMs?: number,
  ): Promise<Result<DelegationGrant, KoiError>> {
    // Escalation prevention: verify grantor holds all permissions being delegated
    const escalationResult = await checkEscalation(issuerId, scope);
    if (!escalationResult.ok) return escalationResult;

    const result = createGrant({
      issuerId,
      delegateeId,
      scope,
      maxChainDepth: config.maxChainDepth,
      ttlMs: ttlMs ?? config.defaultTtlMs,
      secret: config.secret,
    });

    if (!result.ok) return result;

    await storeGrantAndNotify(result.value);

    return result;
  }

  async function attenuate(
    parentId: DelegationId,
    delegateeId: AgentId,
    scope: DelegationScope,
    ttlMs?: number,
  ): Promise<Result<DelegationGrant, KoiError>> {
    const parent = grantStore.get(parentId);
    if (parent === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Parent grant not found: ${parentId}`,
          retryable: false,
          context: { parentId },
        },
      };
    }

    // Escalation prevention: verify the attenuator holds all permissions being delegated
    const escalationResult = await checkEscalation(parent.delegateeId, scope);
    if (!escalationResult.ok) return escalationResult;

    const result = attenuateGrant(
      parent,
      ttlMs !== undefined ? { delegateeId, scope, ttlMs } : { delegateeId, scope },
      config.secret,
    );

    if (!result.ok) return result;

    await storeGrantAndNotify(result.value);

    return result;
  }

  async function revokeInternal(
    id: DelegationId,
    cascade: boolean,
  ): Promise<readonly DelegationId[]> {
    const revokedIds = await revokeGrant(id, revocationRegistry, grantIndex, cascade);

    emit({
      kind: "delegation:revoked",
      grantId: id,
      cascade,
      revokedIds,
    });

    // Fire onRevoke hook BEFORE store deletion so hooks can still look up
    // grant data (e.g., Nexus tuple cleanup needs grant scope to map tuples).
    // The grants are already marked as revoked in the registry, so concurrent
    // verify() calls will fail at the revocation check.
    if (onRevokeHook !== undefined) {
      for (const revokedId of revokedIds) {
        try {
          await onRevokeHook(revokedId, cascade);
        } catch (_hookError: unknown) {
          // Best-effort: revocation is the safety operation, never roll it back
        }
      }
    }

    // Remove from store, index, and cache (after hooks have run)
    for (const revokedId of revokedIds) {
      verifyCache.invalidate(revokedId);
      const revokedGrant = grantStore.get(revokedId);
      if (revokedGrant !== undefined) {
        grantIndex.removeGrant(revokedGrant);
        grantStore.delete(revokedId);
      }
    }

    return revokedIds;
  }

  async function revoke(id: DelegationId, cascade?: boolean): Promise<readonly DelegationId[]> {
    return revokeInternal(id, cascade ?? false);
  }

  async function verify(grantId: DelegationId, toolId: string): Promise<DelegationVerifyResult> {
    const storedGrant = grantStore.get(grantId);
    if (storedGrant === undefined) {
      return { ok: false, reason: "unknown_grant" };
    }

    // Session check runs BEFORE verify cache — a cached "allowed" must not
    // be served after the owning session has expired.
    if (storedGrant.scope.sessionId !== undefined && getActiveSessions !== undefined) {
      const activeSessions = await getActiveSessions();
      if (!activeSessions.has(storedGrant.scope.sessionId)) {
        emit({
          kind: "delegation:denied",
          grantId,
          toolId,
          reason: "session_expired",
        });
        return { ok: false, reason: "session_expired" };
      }
    }

    // Expiry check runs BEFORE verify cache — a cached "allowed" must not
    // be served after the grant's TTL has elapsed.
    if (storedGrant.expiresAt <= Date.now()) {
      verifyCache.invalidate(grantId);
      emit({
        kind: "delegation:denied",
        grantId,
        toolId,
        reason: "expired",
      });
      return { ok: false, reason: "expired" };
    }

    // Fast path — return cached result if available
    const cached = verifyCache.get(grantId, toolId);
    if (cached === true) {
      return { ok: true, grant: storedGrant };
    }

    const result = await verifyGrant(
      storedGrant,
      toolId,
      revocationRegistry,
      config.secret,
      undefined,
      scopeChecker,
    );

    if (!result.ok) {
      emit({
        kind: "delegation:denied",
        grantId,
        toolId,
        reason: result.reason,
      });
    } else {
      verifyCache.set(grantId, toolId, true);
    }

    return result;
  }

  function list(agentId?: AgentId): readonly DelegationGrant[] {
    if (agentId === undefined) {
      return [...grantStore.values()];
    }
    return [...grantStore.values()].filter(
      (g) => g.delegateeId === agentId || g.issuerId === agentId,
    );
  }

  // ---------------------------------------------------------------------------
  // Circuit breaker wrappers (with event emission)
  // ---------------------------------------------------------------------------

  function recordSuccess(delegateeId: AgentId): void {
    circuitBreaker.recordSuccess(delegateeId);

    const newState = circuitBreaker.getState(delegateeId);
    const prevState = prevCircuitStates.get(delegateeId);

    if (prevState === "open" && newState === "closed") {
      emit({ kind: "delegation:circuit_closed", delegateeId });
    }
    // Clean up tracking when circuit returns to closed (prevents unbounded growth)
    if (newState === "closed") {
      prevCircuitStates.delete(delegateeId);
    } else {
      prevCircuitStates.set(delegateeId, newState);
    }
  }

  function recordFailure(delegateeId: AgentId): void {
    circuitBreaker.recordFailure(delegateeId);

    const newState = circuitBreaker.getState(delegateeId);
    const prevState = prevCircuitStates.get(delegateeId) ?? "closed";

    if (prevState !== "open" && newState === "open") {
      emit({
        kind: "delegation:circuit_opened",
        delegateeId,
        failureCount: config.circuitBreaker.failureThreshold,
      });
    }
    prevCircuitStates.set(delegateeId, newState);
  }

  function canDelegate(delegateeId: AgentId): boolean {
    return circuitBreaker.canExecute(delegateeId);
  }

  function circuitState(delegateeId: AgentId): CircuitState {
    return circuitBreaker.getState(delegateeId);
  }

  function isExhausted(delegateeIds: readonly AgentId[]): boolean {
    if (delegateeIds.length === 0) return false;
    return delegateeIds.every((id) => circuitBreaker.getState(id) === "open");
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  function dispose(): void {
    registryUnsubscribe?.();
    registryUnsubscribe = undefined;
    prevCircuitStates.clear();
    verifyCache.clear();
    inMemoryReg?.dispose();
  }

  return {
    grant,
    attenuate,
    revoke,
    verify,
    list,
    recordSuccess,
    recordFailure,
    canDelegate,
    circuitState,
    isExhausted,
    dispose,
  };
}
