/**
 * Policy-cache middleware — short-circuits tool calls for forge-verified
 * bricks promoted to policy mode.
 *
 * Phase: intercept, priority 150 (before permissions at 200).
 * Eligibility: register() rejects entries with verified !== true.
 * Invalidation: optional StoreChangeNotifier subscription on
 * "updated" | "removed" | "quarantined".
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

export interface PolicyEntry {
  readonly toolId: string;
  readonly brickId: string;
  /**
   * Forge verification proof. Must be true — the cache rejects unverified
   * entries because forge verification is the gate that justifies bypassing
   * the model in the first place.
   */
  readonly verified: boolean;
  /** Pure function of input → decision. Must not depend on external state. */
  readonly execute: (input: JsonObject) => PolicyDecision;
}

export interface PolicyCacheConfig {
  /** Maximum cached policies. Default: 100. */
  readonly maxEntries?: number | undefined;
  /** Optional notifier for event-driven invalidation. */
  readonly notifier?: StoreChangeNotifier | undefined;
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
const PRIORITY = 150;
const PHASE = "intercept" as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPolicyCacheMiddleware(config: PolicyCacheConfig = {}): PolicyCacheHandle {
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const cache = new Map<string, PolicyEntry>();
  const brickIndex = new Map<string, string>();

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

    const previousToolId = brickIndex.get(entry.brickId);
    if (previousToolId !== undefined && previousToolId !== entry.toolId) {
      cache.delete(previousToolId);
    }

    const existing = cache.get(entry.toolId);
    if (existing !== undefined && existing.brickId !== entry.brickId) {
      brickIndex.delete(existing.brickId);
    }

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
    return { ok: true, value: undefined };
  };

  const evict = (brickId: string): void => {
    const toolId = brickIndex.get(brickId);
    if (toolId !== undefined) {
      cache.delete(toolId);
      brickIndex.delete(brickId);
    }
  };

  if (config.notifier !== undefined) {
    config.notifier.subscribe((event: StoreChangeEvent) => {
      if (event.kind === "updated" || event.kind === "removed" || event.kind === "quarantined") {
        evict(event.brickId);
      }
    });
  }

  const middleware: KoiMiddleware = {
    name: NAME,
    priority: PRIORITY,
    phase: PHASE,

    async wrapToolCall(_ctx, request: ToolRequest, next): Promise<ToolResponse> {
      const entry = cache.get(request.toolId);
      if (entry === undefined) return next(request);

      const decision = entry.execute(request.input);
      if (decision.action === "allow") return next(request);

      return {
        output: { error: true, message: `Policy blocked: ${decision.reason}` },
      };
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
