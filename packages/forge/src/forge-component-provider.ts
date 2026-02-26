/**
 * ForgeComponentProvider — attaches forged bricks as components to agents.
 *
 * Implements the L0 ComponentProvider interface. On first attach(), it discovers
 * all active bricks from the ForgeStore: tool bricks are wrapped as executable
 * Tools; implementation bricks (middleware, channel) are registered as raw
 * ImplementationArtifact values under kind-specific tokens.
 * Results are cached for subsequent attach() calls.
 *
 * Lazy loading (decision 13A): bricks are loaded on first attach(), not at creation.
 * Scope + zoneId filtering (Issue 8A): only agent-scoped + zone-scoped bricks visible.
 * Delta-based invalidation (Issue 15A): invalidate by scope or brick ID.
 */

import type {
  Agent,
  BrickKind,
  ComponentProvider,
  ForgeScope,
  ForgeStore,
  ImplementationArtifact,
  StoreChangeNotifier,
  TieredSandboxExecutor,
  TrustTier,
} from "@koi/core";
import {
  COMPONENT_PRIORITY,
  channelToken,
  MIN_TRUST_BY_KIND,
  middlewareToken,
  toolToken,
} from "@koi/core";
import { brickToTool } from "./brick-conversion.js";
import { checkBrickRequires } from "./requires-check.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SANDBOX_TIMEOUT_MS = 5_000;

/** Brick kinds that represent implementation artifacts (discoverable as ECS components). */
const IMPLEMENTATION_KINDS: ReadonlySet<BrickKind> = new Set(["middleware", "channel"]);

/** Trust tier ordering: sandbox < verified < promoted. */
const TRUST_TIER_LEVEL: Readonly<Record<TrustTier, number>> = {
  sandbox: 0,
  verified: 1,
  promoted: 2,
} as const;

/** Returns true if `actual` meets or exceeds `required` trust tier. */
function meetsMinTrust(actual: TrustTier, required: TrustTier): boolean {
  return TRUST_TIER_LEVEL[actual] >= TRUST_TIER_LEVEL[required];
}

/** Maps an implementation brick kind + name to the correct namespaced token string. */
function implementationToken(kind: ImplementationArtifact["kind"], name: string): string {
  switch (kind) {
    case "middleware":
      return middlewareToken(name) as string;
    case "channel":
      return channelToken(name) as string;
  }
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
  /** Resolves a brick name to its brick ID. Returns `undefined` for non-forged bricks or before first `attach()`. */
  readonly lookupBrickId: (brickName: string) => string | undefined;
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

/** Map forge scope to component priority for assembly ordering. */
const SCOPE_PRIORITY: Readonly<Record<ForgeScope, number>> = {
  agent: COMPONENT_PRIORITY.AGENT_FORGED,
  zone: COMPONENT_PRIORITY.ZONE_FORGED,
  global: COMPONENT_PRIORITY.GLOBAL_FORGED,
} as const;

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
  // Reverse map: brick name → brick ID (populated during loadComponents)
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

  const loadComponents = async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
    if (cached !== undefined) {
      return cached;
    }

    // Optimize store query when possible (Issue M1).
    // ForgeQuery.scope is exact-match, but the provider needs "at scope or broader".
    // Only "global" callers can use exact-match (they only see global-scoped bricks).
    // No kind filter — we load tools AND implementation bricks in one pass.
    const searchResult = await config.store.search({
      lifecycle: "active",
      ...(config.scope === "global" ? { scope: "global" } : {}),
    });

    if (!searchResult.ok) {
      throw new Error(
        `ForgeComponentProvider: failed to load bricks: ${searchResult.error.message}`,
        { cause: searchResult.error },
      );
    }

    const components: Map<string, unknown> = new Map();
    const scopeTracker: Map<string, ForgeScope> = new Map();
    const nameTracker: Map<string, string> = new Map();

    // Pass 1: Build available tool names set for requires.tools checking
    const availableToolNames: Set<string> = new Set();
    for (const brick of searchResult.value) {
      if (brick.kind === "tool" && brick.lifecycle === "active") {
        if (!isScopeVisible(brick.scope, config.scope)) continue;
        if (brick.scope === "zone" && config.zoneId !== undefined) {
          const zoneTag = `zone:${config.zoneId}`;
          if (!brick.tags.includes(zoneTag)) continue;
        }
        availableToolNames.add(brick.name);
      }
    }

    // Pass 2: Register components with requires enforcement
    for (const brick of searchResult.value) {
      // Scope filtering (Issue 8A)
      if (!isScopeVisible(brick.scope, config.scope)) continue;

      // Zone filtering: zone-scoped bricks only visible if zoneId matches a tag
      if (brick.scope === "zone" && config.zoneId !== undefined) {
        const zoneTag = `zone:${config.zoneId}`;
        if (!brick.tags.includes(zoneTag)) continue;
      }

      // Requires enforcement: skip bricks with unsatisfied requirements
      const requiresResult = checkBrickRequires(brick.requires, availableToolNames);
      if (!requiresResult.satisfied) {
        continue;
      }

      if (brick.kind === "tool") {
        // Tool path: wrap as executable Tool under toolToken(name)
        const tok = toolToken(brick.name);
        const { executor: tierExecutor } = config.executor.forTier(brick.trustTier);
        const tool = brickToTool(brick, tierExecutor, timeoutMs);
        components.set(tok as string, tool);
      } else if (IMPLEMENTATION_KINDS.has(brick.kind)) {
        // Trust enforcement: implementation bricks must meet minimum trust tier
        const minTrust = MIN_TRUST_BY_KIND[brick.kind];
        if (!meetsMinTrust(brick.trustTier, minTrust)) {
          continue; // Skip under-trusted bricks
        }
        // Implementation path: register raw artifact under kind-specific token
        const tok = implementationToken(brick.kind as ImplementationArtifact["kind"], brick.name);
        components.set(tok, brick);
      } else {
        // skill, agent — skip (different attachment semantics)
        continue;
      }

      scopeTracker.set(brick.id, brick.scope);
      nameTracker.set(brick.name, brick.id);
    }

    cached = components;
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
    priority: SCOPE_PRIORITY[config.scope ?? "agent"],
    attach: loadComponents,
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

export { brickToTool } from "./brick-conversion.js";
