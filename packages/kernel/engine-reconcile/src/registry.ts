/**
 * In-memory AgentRegistry implementation.
 *
 * Sync operations, Map-based storage, sync watch callbacks.
 * CAS transitions use the generation counter for optimistic concurrency.
 */

import type {
  AgentId,
  KoiError,
  PatchableRegistryFields,
  ProcessDescriptor,
  ProcessState,
  RegistryEntry,
  RegistryEvent,
  RegistryFilter,
  Result,
  TransitionReason,
  VisibilityContext,
} from "@koi/core";
import { mapRegistryEntryToDescriptor, matchesFilter } from "@koi/core";
import { createListenerSet } from "@koi/event-delivery";

// Re-export the type so colocated tests can import { InMemoryRegistry } from "./registry.js"
export type { InMemoryRegistry } from "./governance-types.js";

import type { InMemoryRegistry } from "./governance-types.js";
import { applyTransition } from "./transitions.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInMemoryRegistry(): InMemoryRegistry {
  const store = new Map<string, RegistryEntry>();
  const listeners = createListenerSet<RegistryEvent>({
    onError: (err) =>
      console.warn("[registry] listener threw:", err instanceof Error ? err.message : err),
  });

  function register(entry: RegistryEntry): RegistryEntry {
    store.set(entry.agentId, entry);
    listeners.notify({ kind: "registered", entry });
    return entry;
  }

  function deregister(id: AgentId): boolean {
    const existed = store.delete(id);
    if (existed) {
      listeners.notify({ kind: "deregistered", agentId: id });
    }
    return existed;
  }

  function lookup(id: AgentId): RegistryEntry | undefined {
    return store.get(id);
  }

  function list(
    filter?: RegistryFilter,
    _visibility?: VisibilityContext,
  ): readonly RegistryEntry[] {
    const entries = [...store.values()];
    if (filter === undefined) return entries;
    return entries.filter((e) => matchesFilter(e, filter));
  }

  function transition(
    id: AgentId,
    targetPhase: ProcessState,
    expectedGeneration: number,
    reason: TransitionReason,
  ): Result<RegistryEntry, KoiError> {
    const current = store.get(id);
    if (current === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Agent ${id} not found in registry`,
          retryable: false,
        },
      };
    }

    const result = applyTransition(current.status, {
      from: current.status.phase,
      to: targetPhase,
      expectedGeneration,
      reason,
    });

    if (!result.ok) return result;

    const updated: RegistryEntry = {
      ...current,
      status: result.value,
    };
    store.set(id, updated);

    listeners.notify({
      kind: "transitioned",
      agentId: id,
      from: current.status.phase,
      to: targetPhase,
      generation: result.value.generation,
      reason,
    });

    return { ok: true, value: updated };
  }

  function patch(id: AgentId, fields: PatchableRegistryFields): Result<RegistryEntry, KoiError> {
    const current = store.get(id);
    if (current === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Agent ${id} not found in registry`,
          retryable: false,
        },
      };
    }

    // Apply only non-undefined fields (copy-on-write)
    const updated: RegistryEntry = {
      ...current,
      ...(fields.priority !== undefined ? { priority: fields.priority } : {}),
      ...(fields.zoneId !== undefined ? { zoneId: fields.zoneId } : {}),
      ...(fields.metadata !== undefined ? { metadata: fields.metadata } : {}),
    };
    store.set(id, updated);

    listeners.notify({ kind: "patched", agentId: id, fields, entry: updated });

    return { ok: true, value: updated };
  }

  function watch(listener: (event: RegistryEvent) => void): () => void {
    return listeners.subscribe(listener);
  }

  async function dispose(): Promise<void> {
    store.clear();
  }

  function descriptor(id: AgentId): ProcessDescriptor | undefined {
    const entry = store.get(id);
    if (entry === undefined) return undefined;
    return mapRegistryEntryToDescriptor(entry);
  }

  return {
    register,
    deregister,
    lookup,
    list,
    transition,
    patch,
    watch,
    descriptor,
    flush: () => {},
    [Symbol.asyncDispose]: dispose,
  };
}
