/**
 * Event-driven tool cache for MCP server.
 *
 * Lazily caches agent.query("tool:") results and invalidates on
 * ForgeStore change events for hot-reload of newly forged tools.
 *
 * Limitation: only ForgeStore.watch() triggers automatic invalidation.
 * Tools added through other mechanisms (dynamic attachment, middleware)
 * require an explicit `invalidate()` call to become visible to MCP clients.
 */

import type { Agent, ForgeStore, JsonObject, Tool, ToolDescriptor } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cached tool entry with descriptor and bound execute function. */
export interface ToolCacheEntry {
  readonly descriptor: ToolDescriptor;
  readonly execute: (args: JsonObject) => Promise<unknown>;
}

/** Configuration for the tool cache. */
export interface ToolCacheConfig {
  /** Agent to enumerate tools from. */
  readonly agent: Agent;
  /** Optional forge store — subscribes to watch() for cache invalidation. */
  readonly forgeStore?: ForgeStore;
  /** Called when cache is invalidated (e.g., to send MCP notifications). */
  readonly onChange?: () => void;
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
 * Create a tool cache that lazily enumerates tools from an Agent.
 *
 * Subscribes to ForgeStore.watch() (if available) to invalidate on
 * brick changes — enabling hot-reload of newly forged tools.
 */
export function createToolCache(config: ToolCacheConfig): ToolCache {
  // justified: mutable cache state encapsulated within factory closure
  let cache: readonly ToolCacheEntry[] | undefined;
  const unsubscribers: Array<() => void> = [];

  function buildCache(): readonly ToolCacheEntry[] {
    const tools = config.agent.query<Tool>("tool:");
    const entries: ToolCacheEntry[] = [];
    for (const [, tool] of tools) {
      // justified: mutable local array being constructed, not shared state
      entries.push({
        descriptor: tool.descriptor,
        execute: (args: JsonObject) => tool.execute(args),
      });
    }
    return entries;
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
    // justified: mutable local array for cleanup tracking
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
