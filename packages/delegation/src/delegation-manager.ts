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
}

export interface DelegationManager {
  // Grant lifecycle
  readonly grant: (
    issuerId: string,
    delegateeId: string,
    scope: DelegationScope,
    ttlMs?: number,
  ) => Result<DelegationGrant, KoiError>;
  readonly attenuate: (
    parentId: DelegationId,
    delegateeId: string,
    scope: DelegationScope,
    ttlMs?: number,
  ) => Result<DelegationGrant, KoiError>;
  readonly revoke: (id: DelegationId, cascade?: boolean) => Promise<readonly DelegationId[]>;
  readonly verify: (grantId: DelegationId, toolId: string) => Promise<DelegationVerifyResult>;
  readonly list: (agentId?: string) => readonly DelegationGrant[];

  // Circuit breaker
  readonly recordSuccess: (delegateeId: string) => void;
  readonly recordFailure: (delegateeId: string) => void;
  readonly canDelegate: (delegateeId: string) => boolean;
  readonly circuitState: (delegateeId: string) => CircuitState;

  // Cleanup
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDelegationManager(params: CreateDelegationManagerParams): DelegationManager {
  const { config, scopeChecker, onEvent } = params;

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
  const prevCircuitStates = new Map<string, CircuitState>();

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
  // Grant lifecycle
  // ---------------------------------------------------------------------------

  function grant(
    issuerId: string,
    delegateeId: string,
    scope: DelegationScope,
    ttlMs?: number,
  ): Result<DelegationGrant, KoiError> {
    const result = createGrant({
      issuerId,
      delegateeId,
      scope,
      maxChainDepth: config.maxChainDepth,
      ttlMs: ttlMs ?? config.defaultTtlMs,
      secret: config.secret,
    });

    if (!result.ok) return result;

    grantStore.set(result.value.id, result.value);
    grantIndex.addGrant(result.value);

    emit({ kind: "delegation:granted", grant: result.value });
    return result;
  }

  function attenuate(
    parentId: DelegationId,
    delegateeId: string,
    scope: DelegationScope,
    ttlMs?: number,
  ): Result<DelegationGrant, KoiError> {
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

    const result = attenuateGrant(
      parent,
      ttlMs !== undefined ? { delegateeId, scope, ttlMs } : { delegateeId, scope },
      config.secret,
    );

    if (!result.ok) return result;

    grantStore.set(result.value.id, result.value);
    grantIndex.addGrant(result.value);

    emit({ kind: "delegation:granted", grant: result.value });
    return result;
  }

  async function revokeInternal(
    id: DelegationId,
    cascade: boolean,
  ): Promise<readonly DelegationId[]> {
    const revokedIds = await revokeGrant(id, revocationRegistry, grantIndex, cascade);

    // Remove from store, index, and cache
    for (const revokedId of revokedIds) {
      verifyCache.invalidate(revokedId);
      const revokedGrant = grantStore.get(revokedId);
      if (revokedGrant !== undefined) {
        grantIndex.removeGrant(revokedGrant);
        grantStore.delete(revokedId);
      }
    }

    emit({
      kind: "delegation:revoked",
      grantId: id,
      cascade,
      revokedIds,
    });

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

  function list(agentId?: string): readonly DelegationGrant[] {
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

  function recordSuccess(delegateeId: string): void {
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

  function recordFailure(delegateeId: string): void {
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

  function canDelegate(delegateeId: string): boolean {
    return circuitBreaker.canExecute(delegateeId);
  }

  function circuitState(delegateeId: string): CircuitState {
    return circuitBreaker.getState(delegateeId);
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
    dispose,
  };
}
