/**
 * Scoped memory wrapper — isolates memory by namespace.
 *
 * Store injects the namespace into options; recall filters results client-side
 * for graceful degradation when the backend ignores the namespace parameter.
 *
 * **Trust model:** The underlying MemoryComponent backend is assumed to be
 * trusted. This wrapper performs capability attenuation (narrowing what a
 * consumer can see), NOT sandboxing against a malicious backend. If the
 * backend returns results with forged namespace metadata, the client-side
 * filter cannot detect the forgery. For untrusted backends, add a
 * cryptographic signing layer above this wrapper.
 */

import type {
  Agent,
  ComponentProvider,
  MemoryComponent,
  MemoryRecallOptions,
  MemoryResult,
  MemoryStoreOptions,
} from "@koi/core";
import { COMPONENT_PRIORITY, MEMORY } from "@koi/core";
import type { MemoryScope } from "./types.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScopedMemory(
  component: MemoryComponent,
  scope: MemoryScope,
): MemoryComponent {
  return {
    async store(content: string, options?: MemoryStoreOptions): Promise<void> {
      return component.store(content, { ...options, namespace: scope.namespace });
    },

    async recall(query: string, options?: MemoryRecallOptions): Promise<readonly MemoryResult[]> {
      const results = await component.recall(query, { ...options, namespace: scope.namespace });
      // Client-side filter for graceful degradation: if the backend ignores
      // the namespace parameter, we still enforce isolation by filtering.
      return results.filter((r) => r.metadata?.namespace === scope.namespace);
    },
  };
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createScopedMemoryProvider(
  component: MemoryComponent,
  scope: MemoryScope,
): ComponentProvider {
  const scoped = createScopedMemory(component, scope);

  return {
    name: `scoped-memory:${scope.namespace}`,
    priority: COMPONENT_PRIORITY.AGENT_FORGED,

    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      return new Map<string, unknown>([[MEMORY as string, scoped]]);
    },
  };
}
