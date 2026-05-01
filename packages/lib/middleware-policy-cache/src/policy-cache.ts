/**
 * Policy-cache middleware — short-circuits tool calls for forge-verified
 * bricks promoted to policy mode.
 *
 * Phase: intercept, priority 50 (outer of permissions@100 — lower = outer).
 * Eligibility: register() rejects entries with verified !== true.
 * Scope: cache identity is owner-aware:
 *   - agent-scoped → keyed by (agent:<agentId>, toolId)
 *   - zone-scoped  → keyed by (zone:<zoneId>, toolId)
 *   - global       → keyed by (global, toolId)
 *   Lookup uses ctx.session.agentId and ctx.session.metadata.zoneId so one
 *   agent's promotion cannot govern another agent's tool calls.
 * Failure handling: a throwing executor is converted to a canonical block
 *   response (fail-closed) AND the entry is auto-evicted so subsequent calls
 *   fall through to next-best scope or to the unwrapped tool path. This
 *   prevents a stale compiled policy from silently disabling enforcement
 *   while still avoiding a bricked-forever cache.
 * Invalidation: optional StoreChangeNotifier subscription on
 *   "updated" | "removed" | "quarantined" events.
 */

import type {
  CapabilityFragment,
  ForgeScope,
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

export type PolicyEntry =
  | (PolicyEntryBase & {
      readonly scope: "agent";
      /** Concrete agent that owns this promotion — keys the cache slot. */
      readonly agentId: string;
    })
  | (PolicyEntryBase & {
      readonly scope: "zone";
      /** Concrete zone that owns this promotion — keys the cache slot. */
      readonly zoneId: string;
    })
  | (PolicyEntryBase & { readonly scope: "global" });

export interface PolicyCacheConfig {
  /** Maximum cached policies. Default: 100. */
  readonly maxEntries?: number | undefined;
  /** Optional notifier for event-driven invalidation. */
  readonly notifier?: StoreChangeNotifier | undefined;
  /**
   * Optional callback invoked when a cached executor throws. The middleware
   * still returns a canonical block response and auto-evicts the entry; this
   * hook lets the host emit audit/metrics for the broken policy. Fire-and-forget.
   */
  readonly onExecutorError?: (info: {
    readonly brickId: string;
    readonly toolId: string;
    readonly scope: ForgeScope;
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
    case "zone":
      return `zone:${entry.zoneId}:${entry.toolId}`;
    case "global":
      return `global:${entry.toolId}`;
  }
}

function readZoneId(ctx: TurnContext): string | undefined {
  // Zone identity is not a first-class TurnContext field. Hosts that wire
  // zone-scoped policies inject the current zoneId into session metadata so
  // the cache can disambiguate during lookup. Anything else is a miss for
  // zone-scoped entries.
  const zoneId = ctx.session.metadata["zoneId"];
  return typeof zoneId === "string" ? zoneId : undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPolicyCacheMiddleware(config: PolicyCacheConfig = {}): PolicyCacheHandle {
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // owner-keyed cache: agent:<agentId>:<toolId>, zone:<zoneId>:<toolId>, global:<toolId>
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
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldEntry = cache.get(oldestKey);
        cache.delete(oldestKey);
        if (oldEntry !== undefined) {
          brickIndex.delete(oldEntry.brickId);
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

  if (config.notifier !== undefined) {
    config.notifier.subscribe((event: StoreChangeEvent) => {
      if (event.kind === "updated" || event.kind === "removed" || event.kind === "quarantined") {
        evict(event.brickId);
      }
    });
  }

  // Lookup precedence: agent (most specific) → zone → global, matching
  // ANS_SCOPE_PRIORITY in @koi/core/name-service.
  const findEntry = (ctx: TurnContext, toolId: string): PolicyEntry | undefined => {
    const agentHit = cache.get(`agent:${ctx.session.agentId}:${toolId}`);
    if (agentHit !== undefined) return agentHit;

    const zoneId = readZoneId(ctx);
    if (zoneId !== undefined) {
      const zoneHit = cache.get(`zone:${zoneId}:${toolId}`);
      if (zoneHit !== undefined) return zoneHit;
    }

    return cache.get(`global:${toolId}`);
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
        // Fail-closed AND quarantine: the entry stays in the cache and
        // every subsequent call returns a canonical block until an external
        // signal (re-register with a fixed brick, or a notifier event)
        // clears the quarantine. This prevents a transient executor fault
        // on a deny policy from silently downgrading to "tool runs normally"
        // via fall-through. (#1207 round 4)
        const reason = "compiled policy executor failed; entry quarantined";
        quarantined.set(entry.brickId, reason);
        // Telemetry hook isolated — a throwing callback must not change
        // enforcement behavior. (#1207 round 4)
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

  return {
    middleware,
    register,
    evict,
    size: (): number => cache.size,
  };
}
