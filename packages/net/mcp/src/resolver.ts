/**
 * MCP resolver — Resolver adapter for MCP tool discovery.
 *
 * Aggregates tool descriptors across all connected MCP servers and resolves
 * individual tools by their namespaced ID (`{serverName}__{toolName}`).
 *
 * Features:
 * - Lazy connection: servers connect on first discover(), not at construction
 * - Per-server cache with dirty flags: only re-fetches from changed servers
 * - Debounced onChange notifications from MCP server tool list changes
 * - Structured partial failure reporting via `failures` property
 */

import type { KoiError, Resolver, Result, Tool, ToolDescriptor } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { McpConnection, McpToolInfo } from "./connection.js";
import {
  mapMcpToolInfoToDescriptor,
  mapMcpToolToKoi,
  parseNamespacedToolName,
  validateServerName,
} from "./tool-adapter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpServerFailure {
  readonly serverName: string;
  readonly error: KoiError;
}

export interface McpResolverOptions {
  /** Per-server timeout for connect + listTools during discover(). Default: 30s. */
  readonly discoverTimeoutMs?: number | undefined;
}

export interface McpResolver extends Resolver<ToolDescriptor, Tool> {
  /** Servers that failed during the most recent discover(). */
  readonly failures: readonly McpServerFailure[];
  /** Unsubscribe from all connection notifications and clear state. */
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Per-server cache entry
// ---------------------------------------------------------------------------

interface ServerCacheEntry {
  readonly tools: readonly McpToolInfo[];
  readonly descriptors: readonly ToolDescriptor[];
  dirty: boolean; // let justified: tracks whether server needs re-fetch
  generation: number; // let justified: monotonic counter to detect stale writes
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 100;
/** Per-server timeout for connect + listTools during discover(). */
const DEFAULT_DISCOVER_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a Resolver that discovers and loads MCP tools across connections.
 *
 * Connections are lazily connected on the first discover() call. Tool lists
 * are cached per-server and only re-fetched when that server's tools change
 * (per `notifications/tools/list_changed`).
 *
 * Call `dispose()` when the resolver is no longer needed.
 */
export function createMcpResolver(
  connections: readonly McpConnection[],
  options?: McpResolverOptions,
): McpResolver {
  // Validate server names: no namespace separator, no duplicates
  const seenNames = new Set<string>();
  for (const conn of connections) {
    validateServerName(conn.serverName);
    if (seenNames.has(conn.serverName)) {
      throw new Error(
        `Duplicate MCP server name "${conn.serverName}". Each connection must have a unique serverName.`,
      );
    }
    seenNames.add(conn.serverName);
  }

  const discoverTimeoutMs = options?.discoverTimeoutMs ?? DEFAULT_DISCOVER_TIMEOUT_MS;
  const cache = new Map<string, ServerCacheEntry>();
  const changeListeners = new Set<() => void>();
  let debounceTimer: ReturnType<typeof setTimeout> | undefined; // let justified: debounce timer
  let currentFailures: readonly McpServerFailure[] = [];
  // Memoized in-flight discover promise — prevents concurrent callers from
  // racing duplicate connects for the same server
  let inflightDiscover: Promise<readonly ToolDescriptor[]> | undefined; // let justified: in-flight memoization
  // Monotonic generation counter — incremented on every tools/list_changed.
  // Refresh writes only land if the generation hasn't advanced since capture.
  let cacheGeneration = 0; // let justified: monotonic counter for stale-write prevention

  // --- Subscribe to tool change notifications per connection ---
  const connectionUnsubs: Array<() => void> = [];
  for (const conn of connections) {
    const unsub = conn.onToolsChanged(() => {
      // Per-server invalidation: mark dirty + bump generation
      const entry = cache.get(conn.serverName);
      if (entry !== undefined) {
        entry.dirty = true;
        entry.generation = ++cacheGeneration;
      } else {
        // No cache entry yet — nothing to invalidate, discover() will fetch
      }
      notifyListeners();
    });
    connectionUnsubs.push(unsub);
  }

  // --- Debounced change notification ---
  function notifyListeners(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      for (const listener of changeListeners) {
        listener();
      }
    }, DEBOUNCE_MS);
  }

  // Per-server discover result type
  type DiscoverResult =
    | {
        readonly serverName: string;
        readonly descriptors: readonly ToolDescriptor[];
        readonly tools: readonly McpToolInfo[];
      }
    | { readonly serverName: string; readonly failure: KoiError };

  // --- Per-server discover (checks abort signal at each step) ---
  async function discoverServer(conn: McpConnection, signal: AbortSignal): Promise<DiscoverResult> {
    const serverName = conn.serverName;

    // Reuse cached descriptors if server is clean (not dirty, has cache)
    const existing = cache.get(serverName);
    if (existing !== undefined && !existing.dirty) {
      return { serverName, descriptors: existing.descriptors, tools: existing.tools };
    }

    // Check abort before connect
    if (signal.aborted) {
      return { serverName, failure: timeoutFailure(serverName) };
    }

    // Capture generation before async work
    const genAtStart = existing?.generation ?? cacheGeneration;

    // Ensure connected (lazy connection on first discover)
    if (conn.state.kind !== "connected") {
      const connectResult = await conn.connect();
      if (!connectResult.ok) {
        return { serverName, failure: connectResult.error };
      }
    }

    // Check abort before listTools
    if (signal.aborted) {
      return { serverName, failure: timeoutFailure(serverName) };
    }

    const toolsResult = await conn.listTools();

    // Check abort before mutating cache — if timed out, don't write stale data
    if (signal.aborted) {
      return { serverName, failure: timeoutFailure(serverName) };
    }

    if (!toolsResult.ok) {
      cache.delete(serverName);
      return { serverName, failure: toolsResult.error };
    }

    const descriptors = toolsResult.value.map((tool) =>
      mapMcpToolInfoToDescriptor(tool, serverName),
    );

    // Only write cache if generation hasn't advanced (same stale-write guard as refreshServerTools)
    const currentGen = cache.get(serverName)?.generation ?? genAtStart;
    if (currentGen <= genAtStart) {
      cache.set(serverName, {
        tools: toolsResult.value,
        descriptors,
        dirty: false,
        generation: genAtStart,
      });
    }

    return { serverName, descriptors, tools: toolsResult.value };
  }

  function timeoutFailure(serverName: string): KoiError {
    return {
      code: "TIMEOUT",
      message: `MCP server "${serverName}" timed out after ${discoverTimeoutMs}ms`,
      retryable: true,
    };
  }

  /**
   * Connect if needed + listTools, updating cache. Used by both discover and load.
   * Captures cache generation before the refresh and only writes if the generation
   * hasn't advanced (prevents a slow refresh from overwriting a newer dirty state).
   */
  async function refreshServerTools(
    conn: McpConnection,
    serverName: string,
  ): Promise<Result<readonly McpToolInfo[], KoiError>> {
    // Capture generation before async work — a tools/list_changed during
    // the refresh will bump the generation, and we must not clear dirty.
    const genAtStart = cache.get(serverName)?.generation ?? cacheGeneration;

    if (conn.state.kind !== "connected") {
      const connectResult = await conn.connect();
      if (!connectResult.ok) return connectResult;
    }
    const toolsResult = await conn.listTools();
    if (!toolsResult.ok) {
      cache.delete(serverName);
      return toolsResult;
    }

    // Only write if generation hasn't advanced since we started.
    // If it advanced, a newer tools/list_changed arrived and our data is stale.
    const currentEntry = cache.get(serverName);
    const currentGen = currentEntry?.generation ?? genAtStart;
    if (currentGen <= genAtStart) {
      cache.set(serverName, {
        tools: toolsResult.value,
        descriptors: toolsResult.value.map((t) => mapMcpToolInfoToDescriptor(t, serverName)),
        dirty: false,
        generation: genAtStart,
      });
    }
    // Return the tools regardless — they're valid for this call even if
    // the cache write was skipped. The next call will see dirty and re-fetch.
    return { ok: true, value: toolsResult.value };
  }

  // --- Discover (with per-server timeout + in-flight memoization) ---
  async function doDiscover(): Promise<readonly ToolDescriptor[]> {
    const allDescriptors: ToolDescriptor[] = [];
    const failures: McpServerFailure[] = [];

    const results = await Promise.allSettled(
      connections.map(async (conn) => {
        // Per-server timeout: AbortController prevents cache mutation from
        // the losing branch, Promise.race bounds wall-clock time even if
        // the underlying connect/listTools cannot be interrupted.
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), discoverTimeoutMs);
        try {
          return await Promise.race<DiscoverResult>([
            discoverServer(conn, ac.signal),
            new Promise<DiscoverResult>((resolve) => {
              ac.signal.addEventListener(
                "abort",
                () =>
                  resolve({
                    serverName: conn.serverName,
                    failure: timeoutFailure(conn.serverName),
                  }),
                { once: true },
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        failures.push({
          serverName: "unknown",
          error: {
            code: "EXTERNAL",
            message: `Unexpected error: ${String(result.reason)}`,
            retryable: false,
          },
        });
        continue;
      }

      const value = result.value;
      if ("failure" in value) {
        failures.push({ serverName: value.serverName, error: value.failure });
      } else {
        allDescriptors.push(...value.descriptors);
      }
    }

    currentFailures = failures;
    return allDescriptors;
  }

  // Memoized discover: concurrent callers share one in-flight pass
  const discover = async (): Promise<readonly ToolDescriptor[]> => {
    if (inflightDiscover !== undefined) return inflightDiscover;
    inflightDiscover = doDiscover().finally(() => {
      inflightDiscover = undefined;
    });
    return inflightDiscover;
  };

  // --- Load ---
  const load = async (id: string): Promise<Result<Tool, KoiError>> => {
    const parsed = parseNamespacedToolName(id);
    if (parsed === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Invalid MCP tool ID format: "${id}". Expected "{serverName}__{toolName}"`,
          retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
        },
      };
    }

    const connection = connections.find((c) => c.serverName === parsed.serverName);
    if (connection === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `MCP server "${parsed.serverName}" not found`,
          retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
          context: { serverName: parsed.serverName },
        },
      };
    }

    // Use cached tool list if available and clean, otherwise fetch.
    // Dirty cache (tools/list_changed received) is treated as a miss.
    const cacheEntry = cache.get(parsed.serverName);
    let cachedTools = cacheEntry !== undefined && !cacheEntry.dirty ? cacheEntry.tools : undefined;
    if (cachedTools === undefined) {
      // Bounded refresh: same timeout as discover() to prevent hangs
      const refreshResult = await Promise.race<Result<readonly McpToolInfo[], KoiError>>([
        refreshServerTools(connection, parsed.serverName),
        new Promise<Result<readonly McpToolInfo[], KoiError>>((resolve) => {
          setTimeout(() => {
            resolve({
              ok: false,
              error: timeoutFailure(parsed.serverName),
            });
          }, discoverTimeoutMs);
        }),
      ]);
      if (!refreshResult.ok) return refreshResult;
      cachedTools = refreshResult.value;
    }

    const toolInfo = cachedTools.find((t) => t.name === parsed.toolName);
    if (toolInfo === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Tool "${parsed.toolName}" not found on MCP server "${parsed.serverName}"`,
          retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
          context: { serverName: parsed.serverName, toolName: parsed.toolName },
        },
      };
    }

    return {
      ok: true,
      value: mapMcpToolToKoi(toolInfo, connection, parsed.serverName),
    };
  };

  // --- onChange ---
  const onChange = (listener: () => void): (() => void) => {
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  };

  // --- Dispose ---
  const dispose = (): void => {
    for (const unsub of connectionUnsubs) {
      unsub();
    }
    connectionUnsubs.length = 0;
    changeListeners.clear();
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    cache.clear();
    currentFailures = [];
  };

  return {
    discover,
    load,
    onChange,
    dispose,
    get failures() {
      return currentFailures;
    },
  };
}
