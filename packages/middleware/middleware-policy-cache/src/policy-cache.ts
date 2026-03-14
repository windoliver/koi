/**
 * Policy-cache middleware — short-circuits model calls for policy-eligible bricks.
 *
 * When forge-optimizer promotes a harness-synthesized middleware to policy mode
 * (100% success over N evaluations), this middleware intercepts matching tool
 * calls and executes the cached policy code directly — no model call needed.
 *
 * Phase: intercept, priority: 150 (before permissions at 200).
 * Invalidation: Event-driven via StoreChangeNotifier subscription.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  StoreChangeEvent,
  StoreChangeNotifier,
  TurnContext,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A cached policy entry for a specific tool.
 * The executor is a compiled wrapToolCall function that validates
 * and short-circuits tool calls without consulting the model.
 */
export interface PolicyEntry {
  readonly toolId: string;
  readonly brickId: string;
  /** The compiled policy function: (input) => validation result. */
  readonly execute: (input: Readonly<Record<string, unknown>>) => PolicyDecision;
}

/** Decision from a policy executor. */
export type PolicyDecision =
  | { readonly action: "allow" }
  | { readonly action: "block"; readonly reason: string };

export interface PolicyCacheConfig {
  /** Maximum cached policies. Default: 100. */
  readonly maxEntries?: number | undefined;
  /** Optional notifier to subscribe for invalidation events. */
  readonly notifier?: StoreChangeNotifier | undefined;
}

export interface PolicyCacheHandle {
  readonly middleware: KoiMiddleware;
  /** Register a policy-eligible brick for caching. */
  readonly register: (entry: PolicyEntry) => void;
  /** Evict a policy by brick ID. */
  readonly evict: (brickId: string) => void;
  /** Number of cached policies. */
  readonly size: () => number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ENTRIES = 100;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a policy-cache middleware that intercepts tool calls for
 * policy-eligible synthesized middleware.
 *
 * Integration:
 * - forge-optimizer detects "promote_to_policy" → L3 wiring calls handle.register()
 * - StoreChangeNotifier fires on deprecation → handle.evict() called
 * - Middleware intercepts matching tool calls before model is consulted
 */
export function createPolicyCacheMiddleware(config: PolicyCacheConfig = {}): PolicyCacheHandle {
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;

  // Tool ID → policy entry (sync lookup for hot path)
  const cache = new Map<string, PolicyEntry>();
  // Brick ID → tool ID (for eviction by brick ID)
  const brickIndex = new Map<string, string>();

  const register = (entry: PolicyEntry): void => {
    // Evict oldest if at capacity
    if (cache.size >= maxEntries && !cache.has(entry.toolId)) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldEntry = cache.get(oldestKey);
        cache.delete(oldestKey);
        if (oldEntry !== undefined) {
          brickIndex.delete(oldEntry.brickId);
        }
      }
    }

    cache.set(entry.toolId, entry);
    brickIndex.set(entry.brickId, entry.toolId);
  };

  const evict = (brickId: string): void => {
    const toolId = brickIndex.get(brickId);
    if (toolId !== undefined) {
      cache.delete(toolId);
      brickIndex.delete(brickId);
    }
  };

  // Subscribe to StoreChangeNotifier for event-driven invalidation
  if (config.notifier !== undefined) {
    const notifier = config.notifier;
    // Fire-and-forget subscription setup
    void Promise.resolve(
      notifier.subscribe((event: StoreChangeEvent) => {
        if (event.kind === "updated" || event.kind === "removed") {
          evict(event.brickId);
        }
      }),
    ).catch(() => {});
  }

  const middleware: KoiMiddleware = {
    name: "policy-cache",
    priority: 150,
    phase: "intercept",

    async wrapToolCall(_ctx, req, next) {
      const entry = cache.get(req.toolId);
      if (entry === undefined) {
        return next(req);
      }

      // Execute the cached policy
      const decision = entry.execute(req.input as Readonly<Record<string, unknown>>);

      if (decision.action === "allow") {
        // Policy says this call is valid — proceed to tool execution
        return next(req);
      }

      // Policy says block — return error without calling the model or tool
      return {
        output: { error: true, message: `Policy blocked: ${decision.reason}` },
      };
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      if (cache.size === 0) return undefined;
      return {
        label: "policy-cache",
        description: `${String(cache.size)} tool${cache.size === 1 ? "" : "s"} in policy mode (deterministic interception)`,
      };
    },
  };

  return { middleware, register, evict, size: () => cache.size };
}
