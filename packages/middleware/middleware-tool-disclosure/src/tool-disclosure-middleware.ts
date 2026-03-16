/**
 * Tool disclosure middleware — progressive disclosure for forged tools.
 *
 * When the tool count exceeds a configurable threshold, this middleware
 * replaces full ToolDescriptor[] with lightweight ToolSummary[] in the
 * model's context. Tools are promoted to full descriptor level on demand
 * when the agent requests them via the `promote_tools` companion tool.
 *
 * Below the threshold, all tools are passed through as-is (zero overhead).
 *
 * Token savings: ~93% for 200+ tools (60K → 4K tokens at discovery level).
 */

import type {
  BrickId,
  BrickSummary,
  CapabilityFragment,
  ForgeStore,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  TokenEstimator,
  ToolDescriptor,
  ToolSummary,
  TurnContext,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Default tool count threshold below which disclosure is bypassed. */
export const DEFAULT_DISCLOSURE_THRESHOLD = 50;

/** Default LRU cache capacity for promoted descriptors. */
const DEFAULT_CACHE_CAPACITY = 100;

export interface ToolDisclosureConfig {
  /** ForgeStore for loading full tool descriptors on promotion. */
  readonly store: ForgeStore;
  /**
   * Tool count threshold. Below this, all tools are eagerly loaded (current behavior).
   * Above this, tools are exposed at summary level with on-demand promotion.
   * Default: 50.
   */
  readonly threshold?: number;
  /** Maximum number of promoted descriptors to cache. Default: 100. */
  readonly cacheCapacity?: number;
  /** Optional token estimator for budget-aware promotion. */
  readonly estimator?: TokenEstimator;
}

// ---------------------------------------------------------------------------
// LRU cache for promoted descriptors
// ---------------------------------------------------------------------------

interface DescriptorCache {
  readonly get: (name: string) => ToolDescriptor | undefined;
  readonly set: (name: string, descriptor: ToolDescriptor) => void;
  readonly has: (name: string) => boolean;
  readonly promotedNames: () => ReadonlySet<string>;
  readonly clear: () => void;
}

function createDescriptorCache(capacity: number): DescriptorCache {
  // let justified: mutable LRU map — order tracks recency
  const cache = new Map<string, ToolDescriptor>();

  return {
    get(name: string): ToolDescriptor | undefined {
      const value = cache.get(name);
      if (value === undefined) return undefined;
      // Move to end (most recently used)
      cache.delete(name);
      cache.set(name, value);
      return value;
    },
    set(name: string, descriptor: ToolDescriptor): void {
      if (cache.has(name)) {
        cache.delete(name);
      } else if (cache.size >= capacity) {
        // Evict least recently used (first entry)
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined) {
          cache.delete(firstKey);
        }
      }
      cache.set(name, descriptor);
    },
    has(name: string): boolean {
      return cache.has(name);
    },
    promotedNames(): ReadonlySet<string> {
      return new Set(cache.keys());
    },
    clear(): void {
      cache.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Summary projection
// ---------------------------------------------------------------------------

/** Project a BrickSummary to a ToolSummary. */
export function brickSummaryToToolSummary(summary: BrickSummary): ToolSummary {
  return {
    name: summary.name,
    description: summary.description,
    ...(summary.tags.length > 0 ? { tags: summary.tags } : {}),
  };
}

// ---------------------------------------------------------------------------
// Promote tools helper
// ---------------------------------------------------------------------------

/**
 * Promotes tools by name: loads full ToolDescriptor from the store and
 * caches the result. Returns the names that were successfully promoted.
 */
async function promoteTools(
  names: readonly string[],
  allDescriptors: ReadonlyMap<string, ToolDescriptor>,
  store: ForgeStore,
  cache: DescriptorCache,
  brickIdLookup: (name: string) => BrickId | undefined,
): Promise<readonly string[]> {
  const promoted: string[] = [];

  for (const name of names) {
    // Already promoted — skip store round-trip
    if (cache.has(name)) {
      promoted.push(name);
      continue;
    }

    // Check if we have the descriptor in the current tool set (non-forged tools)
    const existing = allDescriptors.get(name);
    if (existing !== undefined) {
      cache.set(name, existing);
      promoted.push(name);
      continue;
    }

    // Load from store by brick ID
    const id = brickIdLookup(name);
    if (id === undefined) continue;

    const result = await store.load(id);
    if (!result.ok) continue;

    const brick = result.value;
    if (brick.kind !== "tool") continue;

    const descriptor: ToolDescriptor = {
      name: brick.name,
      description: brick.description,
      inputSchema: brick.inputSchema as Record<string, unknown>,
    };
    cache.set(name, descriptor);
    promoted.push(name);
  }

  return promoted;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export interface ToolDisclosureMiddleware extends KoiMiddleware {
  /**
   * Promote tools by name. Loads full descriptors from the store and
   * caches them. Returns the names that were successfully promoted.
   * Used by the `promote_tools` companion tool.
   */
  readonly promoteByName: (names: readonly string[]) => Promise<readonly string[]>;
  /** Clear the promotion cache. */
  readonly clearCache: () => void;
}

export function createToolDisclosureMiddleware(
  config: ToolDisclosureConfig,
): ToolDisclosureMiddleware {
  const threshold = config.threshold ?? DEFAULT_DISCLOSURE_THRESHOLD;
  const cache = createDescriptorCache(config.cacheCapacity ?? DEFAULT_CACHE_CAPACITY);

  // Memoization state for building the tools array
  // let justified: mutable ref tracking for identity-based memoization skip
  let lastInputRef: readonly ToolDescriptor[] | undefined;
  // let justified: mutable cached output
  let lastOutput: readonly ToolDescriptor[] | undefined;
  // let justified: mutable promoted set ref for change detection
  let lastPromotedSize = 0;

  // Index of all tool descriptors by name (rebuilt when input ref changes)
  // let justified: mutable map rebuilt on input change
  let descriptorIndex = new Map<string, ToolDescriptor>();

  // Brick ID lookup function (injected externally, e.g., from ForgeComponentProvider)
  // let justified: mutable function ref updated via setBrickIdLookup
  const brickIdLookup: (name: string) => BrickId | undefined = () => undefined;

  function buildDisclosedTools(tools: readonly ToolDescriptor[]): readonly ToolDescriptor[] {
    // Below threshold — pass through all tools unchanged
    if (tools.length <= threshold) {
      return tools;
    }

    const promotedNames = cache.promotedNames();

    // Check memoization: same input ref + same promoted set size → same output
    if (
      lastInputRef === tools &&
      promotedNames.size === lastPromotedSize &&
      lastOutput !== undefined
    ) {
      return lastOutput;
    }

    // Rebuild descriptor index if input ref changed
    if (lastInputRef !== tools) {
      descriptorIndex = new Map<string, ToolDescriptor>();
      for (const t of tools) {
        descriptorIndex.set(t.name, t);
      }
    }

    // Build output: promoted tools get full descriptors, others get summaries cast as descriptors
    // The model needs the inputSchema to actually call a tool, so promoted tools keep it.
    // Summary-level tools have a minimal inputSchema placeholder so they remain valid descriptors.
    const result: ToolDescriptor[] = [];
    for (const tool of tools) {
      if (promotedNames.has(tool.name)) {
        // Use cached descriptor (may have been loaded from store)
        const cached = cache.get(tool.name);
        result.push(cached ?? tool);
      } else {
        // Summary: strip inputSchema to save tokens
        result.push({
          name: tool.name,
          description: tool.description,
          inputSchema: {},
          ...(tool.tags !== undefined && tool.tags.length > 0 ? { tags: tool.tags } : {}),
        });
      }
    }

    // Update memoization state
    lastInputRef = tools;
    lastOutput = result;
    lastPromotedSize = promotedNames.size;

    return result;
  }

  const middleware: ToolDisclosureMiddleware = {
    name: "tool-disclosure",
    priority: 50, // Run early — before other middleware sees the tool list
    phase: "intercept",

    wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      if (request.tools === undefined || request.tools.length <= threshold) {
        return next(request);
      }

      const disclosedTools = buildDisclosedTools(request.tools);
      return next({ ...request, tools: disclosedTools });
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      // Only inject description when disclosure is active
      const promoted = cache.promotedNames();
      if (promoted.size === 0 && threshold >= 9999) {
        return undefined;
      }
      return {
        label: "tool-disclosure",
        description: `${promoted.size} tools promoted to full descriptor. Use promote_tools to load full schemas for tools you want to call.`,
      };
    },

    async promoteByName(names: readonly string[]): Promise<readonly string[]> {
      return promoteTools(names, descriptorIndex, config.store, cache, brickIdLookup);
    },

    clearCache(): void {
      cache.clear();
      lastOutput = undefined;
      lastPromotedSize = 0;
    },
  };

  return middleware;
}

// ---------------------------------------------------------------------------
// Companion tool — promote_tools
// ---------------------------------------------------------------------------

export interface PromoteToolsConfig {
  readonly middleware: ToolDisclosureMiddleware;
}

/**
 * Creates the `promote_tools` companion tool that agents use to request
 * full descriptors for tools they want to call.
 */
export function createPromoteToolDescriptor(): ToolDescriptor {
  return {
    name: "promote_tools",
    description:
      "Load full tool schemas for the named tools. Call this before using a tool whose inputSchema is empty (summary-level). Returns the list of successfully promoted tool names.",
    inputSchema: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "Tool names to promote to full descriptor level.",
        },
      },
      required: ["names"],
    },
  };
}
