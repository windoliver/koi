/**
 * Policy-cache middleware — short-circuits tool calls for forge-verified
 * bricks promoted to policy mode.
 *
 * Phase: intercept, priority 50 (outer of permissions@100 — lower = outer).
 * Eligibility: register() rejects entries with verified !== true.
 * Scope: agent-scoped (keyed by agentId) or global. Zone scope is intentionally
 *   omitted — `SessionContext` has no first-class zone field, and silently
 *   matching via opt-in metadata would let zone-scoped denies fail open in any
 *   host that hadn't wired a resolver. Add zone scope only after the runtime
 *   threads zone identity through `SessionContext`.
 * Failure handling: a throwing executor returns a canonical block response
 *   (fail-closed) AND quarantines the entry. Subsequent calls keep blocking
 *   until forge re-promotes a fixed brick or an external notifier event clears
 *   the entry. No fall-through to next-best scope — that would silently
 *   downgrade a deny.
 * Eviction: real LRU on capacity overflow (lookups touch entries).
 * Invalidation: optional StoreChangeNotifier subscription on
 *   "updated" | "removed" | "quarantined" events. The handle exposes
 *   `dispose()` so hosts can release the subscription before dropping the
 *   middleware.
 */

import type {
  CapabilityFragment,
  JsonObject,
  KoiError,
  KoiMiddleware,
  Result,
  StoreChangeEvent,
  StoreChangeNotifier,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PolicyDecision =
  | { readonly action: "allow" }
  | { readonly action: "block"; readonly reason: string };

interface PolicyEntryBase {
  readonly toolId: string;
  readonly brickId: string;
  /** Forge verification proof. Required to be true; rejected otherwise. */
  readonly verified: boolean;
  /** Pure function of input → decision. Must not depend on external state. */
  readonly execute: (input: JsonObject) => PolicyDecision;
}

/**
 * Owner-keyed policy entry. The current API supports `agent` and `global`
 * scopes. Zone scope was deliberately removed: until the runtime injects a
 * zone identifier into `SessionContext`, supporting `scope: "zone"` would
 * let zone-scoped denies silently miss in default hosts.
 */
export type PolicyEntry =
  | (PolicyEntryBase & {
      readonly scope: "agent";
      /** Concrete agent that owns this promotion — keys the cache slot. */
      readonly agentId: string;
    })
  | (PolicyEntryBase & { readonly scope: "global" });

/** Subset of `ForgeScope` actually supported by this middleware. */
export type SupportedScope = PolicyEntry["scope"];

export interface PolicyCacheConfig {
  /** Maximum cached policies. Default: 100. */
  readonly maxEntries?: number | undefined;
  /** Optional notifier for event-driven invalidation. */
  readonly notifier?: StoreChangeNotifier | undefined;
  /**
   * Optional callback invoked when a cached executor throws. The middleware
   * still returns a canonical block response and quarantines the entry; this
   * hook lets the host emit audit/metrics for the broken policy.
   * Fire-and-forget — the implementation isolates the call so a throwing
   * callback cannot change enforcement behavior.
   */
  readonly onExecutorError?: (info: {
    readonly brickId: string;
    readonly toolId: string;
    readonly scope: SupportedScope;
    readonly cause: unknown;
  }) => void;
}

export interface PolicyCacheHandle {
  readonly middleware: KoiMiddleware;
  /** Register a verified, compiled policy. Rejects unverified entries. */
  readonly register: (entry: PolicyEntry) => Result<void>;
  /** Evict a policy by brickId. Idempotent. */
  readonly evict: (brickId: string) => void;
  /** Number of cached policies. */
  readonly size: () => number;
  /**
   * Release the handle's resources. Unsubscribes from the configured
   * `StoreChangeNotifier` (if any) and clears all caches. Idempotent —
   * safe to call multiple times. Hosts MUST call this before dropping the
   * handle to avoid leaking subscriptions on long-lived notifiers.
   */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ENTRIES = 100;
const NAME = "policy-cache";
// permissions runs at priority 100; lower = outer onion = runs first.
const PRIORITY = 50;
const PHASE = "intercept" as const;

// ---------------------------------------------------------------------------
// Cache key derivation — scope owner is part of identity
// ---------------------------------------------------------------------------

function entryCacheKey(entry: PolicyEntry): string {
  switch (entry.scope) {
    case "agent":
      return `agent:${entry.agentId}:${entry.toolId}`;
    case "global":
      return `global:${entry.toolId}`;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPolicyCacheMiddleware(config: PolicyCacheConfig = {}): PolicyCacheHandle {
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // owner-keyed cache: agent:<agentId>:<toolId> | global:<toolId>
  // Map insertion order is recency-tracked manually: lookups delete + re-set
  // the entry to bump it to most-recently-used. Capacity overflow then evicts
  // the oldest (truly LRU, not FIFO).
  const cache = new Map<string, PolicyEntry>();
  // brickId → cacheKey for O(1) eviction.
  const brickIndex = new Map<string, string>();
  // Brick IDs whose compiled executor threw. Quarantined entries stay in the
  // cache and always return a canonical block response — they do NOT fall
  // through to next-best scope. Cleared on re-register or external eviction.
  // This is the safety property: a transient executor fault on a deny policy
  // cannot silently downgrade enforcement to "tool runs normally".
  const quarantined = new Map<string, string>(); // brickId → reason

  const register = (entry: PolicyEntry): Result<void> => {
    if (entry.verified !== true) {
      const error: KoiError = {
        code: "VALIDATION",
        message: `policy-cache: refusing unverified brick ${entry.brickId} for tool ${entry.toolId}`,
        retryable: false,
        context: { brickId: entry.brickId, toolId: entry.toolId },
      };
      return { ok: false, error };
    }

    const key = entryCacheKey(entry);

    const previousKey = brickIndex.get(entry.brickId);
    if (previousKey !== undefined && previousKey !== key) {
      cache.delete(previousKey);
    }

    const existing = cache.get(key);
    if (existing !== undefined && existing.brickId !== entry.brickId) {
      brickIndex.delete(existing.brickId);
    }

    if (cache.size >= maxEntries && !cache.has(key)) {
      // True LRU: oldest = least-recently-used because lookups bump entries
      // to the back of the insertion order via delete + re-set.
      const lruKey = cache.keys().next().value;
      if (lruKey !== undefined) {
        const oldEntry = cache.get(lruKey);
        cache.delete(lruKey);
        if (oldEntry !== undefined) {
          brickIndex.delete(oldEntry.brickId);
          quarantined.delete(oldEntry.brickId);
        }
      }
    }

    cache.set(key, entry);
    brickIndex.set(entry.brickId, key);
    // Re-registration clears any prior quarantine on this brickId.
    quarantined.delete(entry.brickId);
    return { ok: true, value: undefined };
  };

  const evict = (brickId: string): void => {
    const key = brickIndex.get(brickId);
    if (key !== undefined) {
      cache.delete(key);
      brickIndex.delete(brickId);
    }
    quarantined.delete(brickId);
  };

  // Notifier subscription — track the unsubscribe so dispose() can release it.
  let unsubscribeNotifier: (() => void) | undefined;
  if (config.notifier !== undefined) {
    unsubscribeNotifier = config.notifier.subscribe((event: StoreChangeEvent) => {
      if (event.kind === "updated" || event.kind === "removed" || event.kind === "quarantined") {
        evict(event.brickId);
      }
    });
  }

  // Lookup with LRU bump. Precedence: agent (most specific) → global.
  const findEntry = (ctx: TurnContext, toolId: string): PolicyEntry | undefined => {
    const agentKey = `agent:${ctx.session.agentId}:${toolId}`;
    const agentHit = cache.get(agentKey);
    if (agentHit !== undefined) {
      // Bump to most-recently-used.
      cache.delete(agentKey);
      cache.set(agentKey, agentHit);
      return agentHit;
    }

    const globalKey = `global:${toolId}`;
    const globalHit = cache.get(globalKey);
    if (globalHit !== undefined) {
      cache.delete(globalKey);
      cache.set(globalKey, globalHit);
      return globalHit;
    }

    return undefined;
  };

  const blockResponse = (toolId: string, reason: string): ToolResponse => ({
    output: `Policy denied tool "${toolId}".`,
    metadata: {
      isError: true,
      blockedByHook: true,
      policyDenied: true,
      hookName: NAME,
      toolId,
      reason,
    },
  });

  const middleware: KoiMiddleware = {
    name: NAME,
    priority: PRIORITY,
    phase: PHASE,

    async wrapToolCall(ctx, request: ToolRequest, next): Promise<ToolResponse> {
      const entry = findEntry(ctx, request.toolId);
      if (entry === undefined) return next(request);

      // Quarantined entries always block — keeps deny policies enforcing
      // even after their executor faults. Cleared by re-register or
      // external eviction (StoreChangeNotifier `removed` / `quarantined`).
      const quarantineReason = quarantined.get(entry.brickId);
      if (quarantineReason !== undefined) {
        return blockResponse(request.toolId, quarantineReason);
      }

      try {
        const decision = entry.execute(request.input);
        if (decision.action === "allow") return next(request);
        return blockResponse(request.toolId, decision.reason);
      } catch (cause) {
        const reason = "compiled policy executor failed; entry quarantined";
        quarantined.set(entry.brickId, reason);
        try {
          config.onExecutorError?.({
            brickId: entry.brickId,
            toolId: entry.toolId,
            scope: entry.scope,
            cause,
          });
        } catch {
          // Swallow callback failures; observability cannot break enforcement.
        }
        return blockResponse(request.toolId, reason);
      }
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      const n = cache.size;
      if (n === 0) return undefined;
      return {
        label: NAME,
        description: `${String(n)} tool${n === 1 ? "" : "s"} in policy mode (deterministic interception)`,
      };
    },
  };

  const dispose = (): void => {
    if (unsubscribeNotifier !== undefined) {
      try {
        unsubscribeNotifier();
      } catch {
        // Swallow notifier teardown errors — disposal must be idempotent.
      }
      unsubscribeNotifier = undefined;
    }
    cache.clear();
    brickIndex.clear();
    quarantined.clear();
  };

  return {
    middleware,
    register,
    evict,
    size: (): number => cache.size,
    dispose,
  };
}
