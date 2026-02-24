/**
 * ForgeComponentProvider — attaches forged tools as components to agents.
 *
 * Implements the L0 ComponentProvider interface. On first attach(), it discovers
 * all active tool bricks from the ForgeStore and wraps each as an executable
 * Tool that runs in the sandbox. Results are cached for subsequent attach() calls.
 *
 * Lazy loading (decision 13A): tools are loaded on first attach(), not at creation.
 * Scope + zoneId filtering (Issue 8A): only agent-scoped + zone-scoped bricks visible.
 * Delta-based invalidation (Issue 15A): invalidate by scope or brick ID.
 */

import type {
  Agent,
  ComponentProvider,
  ForgeScope,
  ForgeStore,
  JsonObject,
  SandboxExecutor,
  StoreChangeNotifier,
  TieredSandboxExecutor,
  Tool,
  ToolArtifact,
  ToolDescriptor,
} from "@koi/core";
import { toolToken } from "@koi/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SANDBOX_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Brick → Tool conversion
// ---------------------------------------------------------------------------

function brickToTool(brick: ToolArtifact, executor: SandboxExecutor, timeoutMs: number): Tool {
  const descriptor: ToolDescriptor = {
    name: brick.name,
    description: brick.description,
    inputSchema: brick.inputSchema,
  };

  const execute = async (input: JsonObject): Promise<unknown> => {
    const result = await executor.execute(brick.implementation, input, timeoutMs);
    if (!result.ok) {
      return {
        ok: false,
        error: {
          code: result.error.code,
          message: `Forged tool "${brick.name}" failed: ${result.error.message}`,
        },
      };
    }
    return result.value.output;
  };

  return {
    descriptor,
    trustTier: brick.trustTier,
    execute,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ForgeComponentProviderConfig {
  readonly store: ForgeStore;
  readonly executor: TieredSandboxExecutor;
  readonly sandboxTimeoutMs?: number;
  /** Agent's current scope — filters bricks to this scope and broader. */
  readonly scope?: ForgeScope | undefined;
  /** Zone identifier — when set, zone-scoped bricks are filtered by this zone tag. */
  readonly zoneId?: string | undefined;
  /** Optional notifier — auto-subscribes for cross-agent cache invalidation. */
  readonly notifier?: StoreChangeNotifier | undefined;
}

/**
 * Extended ComponentProvider with cache invalidation support.
 * Call `invalidate()` after store mutations (save/remove/update) to ensure
 * the next `attach()` re-queries the store for fresh data.
 *
 * Delta-based invalidation (Issue 15A):
 * - `invalidate()` — full cache clear (backward-compatible)
 * - `invalidateByScope(scope)` — clear only if cached bricks include that scope
 * - `invalidateByBrickId(id)` — clear only if the specific brick is cached
 */
export interface ForgeComponentProviderInstance extends ComponentProvider {
  /** Clears the cached tool set. Next `attach()` will re-query the store. */
  readonly invalidate: () => void;
  /** Invalidate cache if it contains bricks of the given scope. */
  readonly invalidateByScope: (scope: ForgeScope) => void;
  /** Invalidate cache if the specific brick ID is cached. */
  readonly invalidateByBrickId: (brickId: string) => void;
  /** Resolves a tool name to its brick ID. Returns `undefined` for non-forged tools or before first `attach()`. */
  readonly lookupBrickId: (toolName: string) => string | undefined;
  /** Unsubscribes from the notifier (if one was provided). */
  readonly dispose: () => void;
}

/**
 * A brick is visible to a caller at `callerScope` if the brick's scope
 * is at the same level or broader (higher numeric value = broader visibility).
 * agent(0) sees all; zone(1) sees zone + global; global(2) sees only global.
 */
const SCOPE_LEVEL: Readonly<Record<ForgeScope, number>> = {
  agent: 0,
  zone: 1,
  global: 2,
} as const;

function isScopeVisible(brickScope: ForgeScope, callerScope: ForgeScope | undefined): boolean {
  if (callerScope === undefined) return true;
  return SCOPE_LEVEL[brickScope] >= SCOPE_LEVEL[callerScope];
}

/**
 * Creates a ComponentProvider that lazily loads forged tools on first attach().
 * Results are cached — subsequent attach() calls return the same tool instances.
 * Call `invalidate()` to clear the cache after store mutations.
 *
 * Scope filtering (Issue 8A): when `config.scope` is set, only bricks at that
 * scope or broader are included. Zone-scoped bricks are further filtered by
 * `config.zoneId` tag matching.
 */
export function createForgeComponentProvider(
  config: ForgeComponentProviderConfig,
): ForgeComponentProviderInstance {
  const timeoutMs = config.sandboxTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
  let cached: ReadonlyMap<string, unknown> | undefined;
  // Track cached brick metadata for delta invalidation
  let cachedBrickScopes: ReadonlyMap<string, ForgeScope> | undefined;
  // Reverse map: tool name → brick ID (populated during loadTools)
  let nameToBrickId: ReadonlyMap<string, string> | undefined;

  const invalidate = (): void => {
    cached = undefined;
    cachedBrickScopes = undefined;
    nameToBrickId = undefined;
  };

  const invalidateByScope = (scope: ForgeScope): void => {
    if (cachedBrickScopes === undefined) return;
    for (const [, brickScope] of cachedBrickScopes) {
      if (brickScope === scope) {
        invalidate();
        return;
      }
    }
  };

  const invalidateByBrickId = (brickId: string): void => {
    if (cachedBrickScopes === undefined) return;
    if (cachedBrickScopes.has(brickId)) {
      invalidate();
    }
  };

  const loadTools = async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
    if (cached !== undefined) {
      return cached;
    }

    // Optimize store query when possible (Issue M1).
    // ForgeQuery.scope is exact-match, but the provider needs "at scope or broader".
    // Only "global" callers can use exact-match (they only see global-scoped bricks).
    const searchResult = await config.store.search({
      kind: "tool",
      lifecycle: "active",
      ...(config.scope === "global" ? { scope: "global" } : {}),
    });

    if (!searchResult.ok) {
      throw new Error(
        `ForgeComponentProvider: failed to load tools: ${searchResult.error.message}`,
        { cause: searchResult.error },
      );
    }

    const tools: Map<string, unknown> = new Map();
    const scopeTracker: Map<string, ForgeScope> = new Map();
    const nameTracker: Map<string, string> = new Map();

    for (const brick of searchResult.value) {
      if (brick.kind !== "tool") continue;

      // Scope filtering (Issue 8A)
      if (!isScopeVisible(brick.scope, config.scope)) continue;

      // Zone filtering: zone-scoped bricks only visible if zoneId matches a tag
      if (brick.scope === "zone" && config.zoneId !== undefined) {
        const zoneTag = `zone:${config.zoneId}`;
        if (!brick.tags.includes(zoneTag)) continue;
      }

      const token = toolToken(brick.name);
      const { executor: tierExecutor } = config.executor.forTier(brick.trustTier);
      const tool = brickToTool(brick, tierExecutor, timeoutMs);
      tools.set(token as string, tool);
      scopeTracker.set(brick.id, brick.scope);
      nameTracker.set(brick.name, brick.id);
    }

    cached = tools;
    cachedBrickScopes = scopeTracker;
    nameToBrickId = nameTracker;
    return cached;
  };

  // Subscribe to notifier for automatic cache invalidation
  let unsubscribe: (() => void) | undefined;
  if (config.notifier !== undefined) {
    unsubscribe = config.notifier.subscribe((event) => {
      if (event.kind === "saved" || event.kind === "removed") {
        // New or removed brick — full invalidation since it might match scope filter
        invalidate();
      } else {
        // "updated" or "promoted" — targeted invalidation
        invalidateByBrickId(event.brickId);
        if (event.scope !== undefined) {
          invalidateByScope(event.scope);
        }
      }
    });
  }

  return {
    name: "forge",
    attach: loadTools,
    invalidate,
    invalidateByScope,
    invalidateByBrickId,
    lookupBrickId: (toolName: string): string | undefined => {
      if (nameToBrickId === undefined) return undefined;
      return nameToBrickId.get(toolName);
    },
    dispose: (): void => {
      if (unsubscribe !== undefined) {
        unsubscribe();
        unsubscribe = undefined;
      }
    },
  };
}

export { brickToTool };
