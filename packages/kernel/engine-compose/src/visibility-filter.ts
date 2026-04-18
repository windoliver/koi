/**
 * Composable decorator that wraps an AgentRegistry to add
 * permission-based visibility filtering on list().
 *
 * All other methods (register, deregister, lookup, transition, patch, watch)
 * delegate directly to the inner registry.
 */

import type {
  AgentRegistry,
  PermissionBackend,
  PermissionQuery,
  RegistryEntry,
  RegistryFilter,
  VisibilityContext,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface VisibilityFilterConfig {
  /** When true, return [] if no VisibilityContext is provided. Default: false (fail-open migration). */
  readonly strictVisibility?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wrap an AgentRegistry with permission-filtered discovery.
 *
 * - `list()` checks each candidate entry against the permission backend.
 * - Only entries where the decision is `"allow"` are returned.
 * - `"deny"` and `"ask"` decisions are treated as filtered out.
 * - On permission backend error: fail-closed (return `[]`, log warning).
 * - When no `VisibilityContext` is provided and `strictVisibility` is false
 *   (default), all entries are returned for backward compatibility.
 */
export function createVisibilityFilter(
  inner: AgentRegistry,
  permissions: PermissionBackend,
  config?: VisibilityFilterConfig,
): AgentRegistry {
  const strict = config?.strictVisibility === true;
  const descriptor: AgentRegistry["descriptor"] =
    inner.descriptor !== undefined ? (agentId) => inner.descriptor?.(agentId) : undefined;

  async function list(
    filter?: RegistryFilter,
    visibility?: VisibilityContext,
  ): Promise<readonly RegistryEntry[]> {
    if (visibility === undefined && strict) {
      return [];
    }

    const candidates = await inner.list(filter, visibility);

    if (visibility === undefined) {
      return candidates;
    }

    if (candidates.length === 0) return [];

    const queries: readonly PermissionQuery[] = candidates.map(
      (entry: RegistryEntry): PermissionQuery => ({
        principal: visibility.callerId,
        action: "discover",
        resource: `agent:${entry.agentId}`,
        ...(visibility.callerZoneId !== undefined
          ? { context: { callerZoneId: visibility.callerZoneId } }
          : {}),
      }),
    );

    try {
      const decisions =
        permissions.checkBatch !== undefined
          ? await permissions.checkBatch(queries)
          : await Promise.all(queries.map((q: PermissionQuery) => permissions.check(q)));

      return candidates.filter(
        (_entry: RegistryEntry, i: number) => decisions[i]?.effect === "allow",
      );
    } catch (e: unknown) {
      // Fail-closed: permission error → empty results
      console.warn(
        "[koi:visibility-filter] Permission check failed, returning empty results",
        e instanceof Error ? e.message : String(e),
      );
      return [];
    }
  }

  return {
    register: (entry) => inner.register(entry),
    deregister: (agentId) => inner.deregister(agentId),
    lookup: (agentId) => inner.lookup(agentId),
    list,
    transition: (agentId, targetPhase, expectedGeneration, reason) =>
      inner.transition(agentId, targetPhase, expectedGeneration, reason),
    patch: (agentId, fields) => inner.patch(agentId, fields),
    watch: (listener) => inner.watch(listener),
    ...(descriptor !== undefined ? { descriptor } : {}),
    [Symbol.asyncDispose]: () => inner[Symbol.asyncDispose](),
  };
}
