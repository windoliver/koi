/**
 * Event-driven tool cache for MCP server.
 *
 * Lazily caches agent tools (via agent.query("tool:")) and optional
 * platform tools. Invalidates on ForgeStore change events for
 * hot-reload of newly forged tools.
 */

import type {
  Agent,
  ForgeStore,
  JsonObject,
  Tool,
  ToolDescriptor,
  ToolExecuteOptions,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cached tool entry with descriptor and bound execute function. */
export interface ToolCacheEntry {
  readonly descriptor: ToolDescriptor;
  readonly execute: (args: JsonObject, options?: ToolExecuteOptions) => Promise<unknown>;
}

/** Configuration for the tool cache. */
export interface ToolCacheConfig {
  /** Agent to enumerate tools from. */
  readonly agent: Agent;
  /** Optional forge store — subscribes to watch() for cache invalidation. */
  readonly forgeStore?: ForgeStore;
  /** Called when cache is invalidated (e.g., to send MCP notifications). */
  readonly onChange?: () => void;
  /** Additional platform tools to merge into the cache. */
  readonly platformTools?: readonly Tool[];
}

/** Read-only tool cache with lazy rebuild and subscription-based invalidation. */
export interface ToolCache {
  /** List all cached tool entries. */
  readonly list: () => readonly ToolCacheEntry[];
  /** Get a tool entry by name. Returns undefined if not found. */
  readonly get: (name: string) => ToolCacheEntry | undefined;
  /** Force cache invalidation. Next list/get call rebuilds from agent. */
  readonly invalidate: () => void;
  /** Number of cached tools. */
  readonly count: () => number;
  /** Dispose ForgeStore subscription. */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a tool cache that lazily enumerates tools from an Agent,
 * merging in optional platform tools.
 *
 * Subscribes to ForgeStore.watch() (if available) to invalidate on
 * brick changes — enabling hot-reload of newly forged tools.
 */
export function createToolCache(config: ToolCacheConfig): ToolCache {
  // justified: mutable cache state encapsulated within factory closure
  let cache: readonly ToolCacheEntry[] | undefined;
  const unsubscribers: Array<() => void> = [];

  function toolToEntry(tool: Tool): ToolCacheEntry {
    return {
      descriptor: tool.descriptor,
      execute: (args: JsonObject, options?: ToolExecuteOptions) => tool.execute(args, options),
    };
  }

  /** Reserved prefix for platform tools — agent tools cannot shadow these. */
  const PLATFORM_PREFIX = "koi_";

  function buildCache(): readonly ToolCacheEntry[] {
    const agentTools = config.agent.query<Tool>("tool:");
    const byName = new Map<string, ToolCacheEntry>();

    // Platform tools are authoritative — register first
    if (config.platformTools !== undefined) {
      for (const tool of config.platformTools) {
        byName.set(tool.descriptor.name, toolToEntry(tool));
      }
    }

    // Agent tools are added only if they don't collide with reserved koi_* names
    for (const [, tool] of agentTools) {
      const name = tool.descriptor.name;
      if (name.startsWith(PLATFORM_PREFIX) && byName.has(name)) {
        // Agent tool with reserved koi_* name — skip to prevent shadow bypass
        continue;
      }
      byName.set(name, toolToEntry(tool));
    }

    return [...byName.values()];
  }

  function invalidate(): void {
    cache = undefined;
    config.onChange?.();
  }

  function ensureCache(): readonly ToolCacheEntry[] {
    if (cache === undefined) {
      cache = buildCache();
    }
    return cache;
  }

  // Subscribe to ForgeStore changes if watch() is available
  if (config.forgeStore?.watch !== undefined) {
    const unsub = config.forgeStore.watch(() => {
      invalidate();
    });
    unsubscribers.push(unsub);
  }

  return {
    list: () => ensureCache(),
    get: (name: string) => ensureCache().find((e) => e.descriptor.name === name),
    invalidate,
    count: () => ensureCache().length,
    dispose: () => {
      for (const unsub of unsubscribers) {
        unsub();
      }
    },
  };
}
