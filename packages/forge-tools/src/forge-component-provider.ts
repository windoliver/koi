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
  AgentDescriptor,
  AttachResult,
  BrickArtifact,
  ComponentProvider,
  ForgeScope,
  ForgeStore,
  SandboxExecutor,
  SkillComponent,
  SkippedComponent,
  StoreChangeNotifier,
} from "@koi/core";
import {
  agentToken,
  COMPONENT_PRIORITY,
  channelToken,
  MIN_TRUST_BY_KIND,
  middlewareToken,
  skillToken,
  toolToken,
} from "@koi/core";
import { DEFAULT_SANDBOX_TIMEOUT_MS } from "@koi/forge-types";
import { brickToTool } from "./brick-conversion.js";
import { meetsMinTrust } from "./brick-resolver.js";
import { checkBrickRequires } from "./requires-check.js";

// ---------------------------------------------------------------------------
// Per-brick attachment (exhaustive switch over all 5 BrickKinds)
// ---------------------------------------------------------------------------

interface BrickAttachEntry {
  readonly token: string;
  readonly value: unknown;
}

function attachBrick(
  brick: BrickArtifact,
  executor: SandboxExecutor,
  timeoutMs: number,
): BrickAttachEntry | undefined {
  // Trust enforcement (universal — all kinds checked)
  const minTrust = MIN_TRUST_BY_KIND[brick.kind];
  if (!meetsMinTrust(brick.trustTier, minTrust)) return undefined;

  switch (brick.kind) {
    case "tool": {
      return {
        token: toolToken(brick.name) as string,
        value: brickToTool(brick, executor, timeoutMs),
      };
    }
    case "skill": {
      const skillValue: SkillComponent = {
        name: brick.name,
        description: brick.description,
        content: brick.content,
        ...(brick.tags.length > 0 ? { tags: brick.tags } : {}),
        ...(brick.requires !== undefined ? { requires: brick.requires } : {}),
      };
      return { token: skillToken(brick.name) as string, value: skillValue };
    }
    case "agent":
      return {
        token: agentToken(brick.name) as string,
        value: {
          name: brick.name,
          description: brick.description,
          manifestYaml: brick.manifestYaml,
        } satisfies AgentDescriptor,
      };
    case "middleware":
      return { token: middlewareToken(brick.name) as string, value: brick };
    case "channel":
      return { token: channelToken(brick.name) as string, value: brick };
    case "composite":
      // Composite bricks resolve via their output kind's step — not directly attachable
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ForgeComponentProviderConfig {
  readonly store: ForgeStore;
  readonly executor: SandboxExecutor;
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
    cachedSkipped = undefined;
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

  // let justified: mutable skip list cleared on invalidate
  let cachedSkipped: readonly SkippedComponent[] | undefined;

  const loadComponents = async (
    _agent: Agent,
  ): Promise<AttachResult | ReadonlyMap<string, unknown>> => {
    if (cached !== undefined) {
      return cachedSkipped !== undefined && cachedSkipped.length > 0
        ? { components: cached, skipped: cachedSkipped }
        : cached;
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
    const skipped: SkippedComponent[] = [];

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

    // Pass 2: Register components with requires enforcement + skip reporting
    for (const brick of searchResult.value) {
      // Scope filtering (Issue 8A)
      if (!isScopeVisible(brick.scope, config.scope)) {
        skipped.push({
          name: brick.name,
          reason: `scope ${brick.scope} not visible to ${config.scope ?? "any"}`,
        });
        continue;
      }

      // Zone filtering: zone-scoped bricks only visible if zoneId matches a tag
      if (brick.scope === "zone" && config.zoneId !== undefined) {
        const zoneTag = `zone:${config.zoneId}`;
        if (!brick.tags.includes(zoneTag)) {
          skipped.push({ name: brick.name, reason: `zone tag ${zoneTag} not found` });
          continue;
        }
      }

      // Requires enforcement: skip bricks with unsatisfied requirements
      const requiresResult = checkBrickRequires(brick.requires, availableToolNames);
      if (!requiresResult.satisfied) {
        const v = requiresResult.violation;
        const detail = v !== undefined ? `${v.kind}:${v.name}` : "unknown";
        skipped.push({ name: brick.name, reason: `unsatisfied requires: ${detail}` });
        continue;
      }

      const result = attachBrick(brick, config.executor, timeoutMs);
      if (result === undefined) {
        skipped.push({
          name: brick.name,
          reason: `trust tier ${brick.trustTier} below minimum for ${brick.kind}`,
        });
        continue;
      }
      components.set(result.token, result.value);
      scopeTracker.set(brick.id, brick.scope);
      nameTracker.set(brick.name, brick.id);
    }

    cached = components;
    cachedBrickScopes = scopeTracker;
    nameToBrickId = nameTracker;
    cachedSkipped = skipped;

    return skipped.length > 0 ? { components: cached, skipped: cachedSkipped } : cached;
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
