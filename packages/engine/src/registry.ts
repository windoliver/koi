/**
 * In-memory AgentRegistry implementation.
 *
 * Sync operations, Map-based storage, sync watch callbacks.
 * CAS transitions use the generation counter for optimistic concurrency.
 */

import type {
  AgentId,
  AgentRegistry,
  KoiError,
  PatchableRegistryFields,
  ProcessState,
  RegistryEntry,
  RegistryEvent,
  RegistryFilter,
  Result,
  TransitionReason,
} from "@koi/core";
import { matchesFilter } from "@koi/core";
import { applyTransition } from "./transitions.js";

// ---------------------------------------------------------------------------
// Public type (for test imports)
// ---------------------------------------------------------------------------

/**
 * In-memory registry narrows all `T | Promise<T>` returns to sync `T`.
 * Omit base method signatures to prevent TypeScript union widening,
 * then re-declare with sync-only return types.
 */
export type InMemoryRegistry = Omit<
  AgentRegistry,
  "register" | "deregister" | "lookup" | "list" | "transition" | "patch"
> & {
  readonly register: (entry: RegistryEntry) => RegistryEntry;
  readonly deregister: (agentId: AgentId) => boolean;
  readonly lookup: (agentId: AgentId) => RegistryEntry | undefined;
  readonly list: (filter?: RegistryFilter) => readonly RegistryEntry[];
  readonly transition: (
    agentId: AgentId,
    targetPhase: ProcessState,
    expectedGeneration: number,
    reason: TransitionReason,
  ) => Result<RegistryEntry, KoiError>;
  readonly patch: (
    agentId: AgentId,
    fields: PatchableRegistryFields,
  ) => Result<RegistryEntry, KoiError>;
  /** Manually trigger flush of any buffered heartbeats. */
  readonly flush: () => void;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInMemoryRegistry(): InMemoryRegistry {
  const store = new Map<string, RegistryEntry>();
  let listeners: ReadonlySet<(event: RegistryEvent) => void> = new Set(); // let: replaced on watch/unsubscribe

  function notify(event: RegistryEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function register(entry: RegistryEntry): RegistryEntry {
    store.set(entry.agentId, entry);
    notify({ kind: "registered", entry });
    return entry;
  }

  function deregister(id: AgentId): boolean {
    const existed = store.delete(id);
    if (existed) {
      notify({ kind: "deregistered", agentId: id });
    }
    return existed;
  }

  function lookup(id: AgentId): RegistryEntry | undefined {
    return store.get(id);
  }

  function list(filter?: RegistryFilter): readonly RegistryEntry[] {
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

    notify({
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

    notify({ kind: "patched", agentId: id, fields, entry: updated });

    return { ok: true, value: updated };
  }

  function watch(listener: (event: RegistryEvent) => void): () => void {
    listeners = new Set([...listeners, listener]);
    return () => {
      listeners = new Set([...listeners].filter((l) => l !== listener));
    };
  }

  async function dispose(): Promise<void> {
    store.clear();
    listeners = new Set();
  }

  return {
    register,
    deregister,
    lookup,
    list,
    transition,
    patch,
    watch,
    flush: () => {},
    [Symbol.asyncDispose]: dispose,
  };
}
