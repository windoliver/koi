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
// Factory
// ---------------------------------------------------------------------------

export function createPolicyCacheMiddleware(config: PolicyCacheConfig = {}): PolicyCacheHandle {
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // Per-owner partitioned caches. Each agent gets its OWN map with its OWN
  // maxEntries quota; global gets its own. This is what gives the cache
  // tenant-safe capacity behavior: a noisy agent registering many policies
  // can only evict that agent's own entries — never another agent's deny.
  // Map insertion order is the recency record (lookups delete + re-set the
  // entry to bump it to most-recently-used; overflow evicts the LRU).
  const agentCaches = new Map<string, Map<string, PolicyEntry>>(); // agentId → toolId → entry
  const globalCache = new Map<string, PolicyEntry>(); // toolId → entry
  // brickId → { cacheKey: "agent:<agentId>" | "global", toolId } for O(1) evict.
  const brickIndex = new Map<string, { readonly bucket: string; readonly toolId: string }>();
  // Brick IDs whose compiled executor threw. Quarantined entries stay in the
  // cache and always return a canonical block response — they do NOT fall
  // through to next-best scope. Cleared on re-register or external eviction.
  const quarantined = new Set<string>(); // brickIds (reason fixed by `QUARANTINE_REASON`)

  const getAgentCache = (agentId: string): Map<string, PolicyEntry> => {
    let m = agentCaches.get(agentId);
    if (m === undefined) {
      m = new Map();
      agentCaches.set(agentId, m);
    }
    return m;
  };

  const bucketFor = (entry: PolicyEntry): { key: string; map: Map<string, PolicyEntry> } => {
    if (entry.scope === "agent") {
      return { key: `agent:${entry.agentId}`, map: getAgentCache(entry.agentId) };
    }
    return { key: "global", map: globalCache };
  };

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

    const { key: bucket, map: bucketMap } = bucketFor(entry);

    // Stale forward entry: this brickId previously lived under a different
    // bucket/toolId — drop it from there before re-inserting here.
    const prior = brickIndex.get(entry.brickId);
    if (prior !== undefined && (prior.bucket !== bucket || prior.toolId !== entry.toolId)) {
      const priorMap =
        prior.bucket === "global"
          ? globalCache
          : agentCaches.get(prior.bucket.slice("agent:".length));
      priorMap?.delete(prior.toolId);
    }

    // Stale reverse entry: another brickId already occupies this (bucket, toolId).
    const existing = bucketMap.get(entry.toolId);
    if (existing !== undefined && existing.brickId !== entry.brickId) {
      brickIndex.delete(existing.brickId);
      quarantined.delete(existing.brickId);
    }

    // Capacity check is per-bucket — one tenant cannot evict another's deny.
    if (bucketMap.size >= maxEntries && !bucketMap.has(entry.toolId)) {
      const lruToolId = bucketMap.keys().next().value;
      if (lruToolId !== undefined) {
        const oldEntry = bucketMap.get(lruToolId);
        bucketMap.delete(lruToolId);
        if (oldEntry !== undefined) {
          brickIndex.delete(oldEntry.brickId);
          quarantined.delete(oldEntry.brickId);
        }
      }
    }

    bucketMap.set(entry.toolId, entry);
    brickIndex.set(entry.brickId, { bucket, toolId: entry.toolId });
    // Re-registration clears any prior quarantine on this brickId.
    quarantined.delete(entry.brickId);
    return { ok: true, value: undefined };
  };

  const evict = (brickId: string): void => {
    const ref = brickIndex.get(brickId);
    if (ref !== undefined) {
      const map =
        ref.bucket === "global" ? globalCache : agentCaches.get(ref.bucket.slice("agent:".length));
      map?.delete(ref.toolId);
      brickIndex.delete(brickId);
      // Garbage-collect empty agent caches so per-agent state doesn't leak.
      if (ref.bucket !== "global") {
        const agentId = ref.bucket.slice("agent:".length);
        if (agentCaches.get(agentId)?.size === 0) {
          agentCaches.delete(agentId);
        }
      }
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
    const agentMap = agentCaches.get(ctx.session.agentId);
    if (agentMap !== undefined) {
      const agentHit = agentMap.get(toolId);
      if (agentHit !== undefined) {
        agentMap.delete(toolId);
        agentMap.set(toolId, agentHit);
        return agentHit;
      }
    }

    const globalHit = globalCache.get(toolId);
    if (globalHit !== undefined) {
      globalCache.delete(toolId);
      globalCache.set(toolId, globalHit);
      return globalHit;
    }

    return undefined;
  };

  // Canonical block response. NOTE: `reason` is intentionally NOT placed in
  // metadata. event-trace allowlists `reason` and persists it to long-lived
  // trajectory storage, so an executor-supplied string could leak rule
  // internals or input fragments through that boundary. middleware-permissions
  // applies the same trust-boundary policy: classify in metadata, never
  // forward executor text.
  const blockResponse = (toolId: string): ToolResponse => ({
    output: `Policy denied tool "${toolId}". This tool is not available in the current scope.`,
    metadata: {
      isError: true,
      blockedByHook: true,
      policyDenied: true,
      hookName: NAME,
      toolId,
    },
  });

  const sizeOf = (): number => {
    let n = globalCache.size;
    for (const m of agentCaches.values()) n += m.size;
    return n;
  };

  // Per-context size for capability reporting — only the current agent's
  // bucket plus the global bucket. Reporting the process-wide size would
  // leak other tenants' policy counts into this turn's prompt context and
  // make injection non-deterministic across agents sharing one handle.
  const sizeFor = (ctx: TurnContext): number => {
    const agent = agentCaches.get(ctx.session.agentId);
    return globalCache.size + (agent?.size ?? 0);
  };

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
      if (quarantined.has(entry.brickId)) {
        return blockResponse(request.toolId);
      }

      try {
        const decision = entry.execute(request.input);
        if (decision.action === "allow") return next(request);
        return blockResponse(request.toolId);
      } catch (cause) {
        quarantined.add(entry.brickId);
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
        return blockResponse(request.toolId);
      }
    },

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      const n = sizeFor(ctx);
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
    agentCaches.clear();
    globalCache.clear();
    brickIndex.clear();
    quarantined.clear();
  };

  return {
    middleware,
    register,
    evict,
    size: sizeOf,
    dispose,
  };
}
