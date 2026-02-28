/**
 * Event-sourced AgentRegistry implementation.
 *
 * Events are the source of truth. Current state is a derived projection
 * maintained as an in-memory cache, updated synchronously after each append.
 *
 * Each agent has its own event stream ("agent:<agentId>"). A shared index
 * stream ("agent-registry-index") tracks which agents exist for startup
 * rebuild.
 *
 * L2 package — imports only from @koi/core (L0).
 */

import type {
  AgentId,
  AgentRegistry,
  AgentStateEvent,
  EventBackend,
  KoiError,
  ProcessState,
  RegistryEntry,
  RegistryEvent,
  RegistryFilter,
  Result,
  TransitionReason,
} from "@koi/core";
import {
  agentId,
  conflict,
  evolveRegistryEntry,
  isAgentStateEvent,
  matchesFilter,
  notFound,
  VALID_TRANSITIONS,
  validation,
} from "@koi/core";
import { agentStreamId, REGISTRY_INDEX_STREAM } from "./stream-ids.js";

// ---------------------------------------------------------------------------
// Public type (sync-narrowed, matches InMemoryRegistry pattern)
// ---------------------------------------------------------------------------

/**
 * Event-sourced registry narrows async returns to sync for operations
 * that only read the in-memory projection. transition and register
 * remain async because they append to the event backend.
 */
export type EventSourcedRegistry = Omit<AgentRegistry, "lookup" | "list"> & {
  readonly lookup: (agentId: AgentId) => RegistryEntry | undefined;
  readonly list: (filter?: RegistryFilter) => readonly RegistryEntry[];
  /** Re-fold all events from the backend to rebuild the projection. */
  readonly rebuild: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an event-sourced AgentRegistry backed by an EventBackend.
 *
 * Returns a Promise because startup requires folding existing events
 * from the backend to rebuild the projection cache.
 */
export async function createEventSourcedRegistry(
  backend: EventBackend,
): Promise<EventSourcedRegistry> {
  // Mutable internal state — projection cache
  const projection = new Map<string, RegistryEntry>();
  const sequenceMap = new Map<string, number>(); // agentId → last known stream sequence
  const knownAgentIds = new Set<AgentId>(); // tracks all ever-registered agent IDs

  // let: replaced on watch/unsubscribe (same pattern as InMemoryRegistry)
  let listeners: ReadonlySet<(event: RegistryEvent) => void> = new Set();

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function notify(event: RegistryEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  /**
   * Inline transition validation using VALID_TRANSITIONS from L0.
   * Avoids importing L1 applyTransition (L2 cannot depend on L1).
   */
  function validateAndApplyTransition(
    current: RegistryEntry,
    targetPhase: ProcessState,
    expectedGeneration: number,
    reason: TransitionReason,
  ): Result<AgentStateEvent, KoiError> {
    // CAS check: generation must match
    if (current.status.generation !== expectedGeneration) {
      return {
        ok: false,
        error: conflict(
          current.agentId,
          `Stale generation: expected ${String(expectedGeneration)}, current is ${String(current.status.generation)}`,
        ),
      };
    }

    // Validate edge
    const allowed = VALID_TRANSITIONS[current.status.phase];
    if (!allowed.some((s) => s === targetPhase)) {
      return {
        ok: false,
        error: validation(
          `Invalid transition: ${current.status.phase} → ${targetPhase}. Allowed: [${allowed.join(", ")}]`,
        ),
      };
    }

    const event: AgentStateEvent = {
      kind: "agent_transitioned",
      agentId: current.agentId,
      from: current.status.phase,
      to: targetPhase,
      generation: current.status.generation + 1,
      reason,
      conditions: [...current.status.conditions],
      transitionedAt: Date.now(),
    };

    return { ok: true, value: event };
  }

  /** Append an index event (lightweight, just tracks agent IDs). */
  async function appendIndexEvent(
    type: "index:registered" | "index:deregistered",
    id: AgentId,
  ): Promise<void> {
    await backend.append(REGISTRY_INDEX_STREAM, {
      type,
      data: { agentId: id },
    });
  }

  /** Parse an index entry's agentId from an unknown payload. */
  function parseIndexAgentId(data: unknown): AgentId | undefined {
    if (typeof data !== "object" || data === null) return undefined;
    const raw = (data as Readonly<Record<string, unknown>>).agentId;
    if (typeof raw !== "string" || raw === "") return undefined;
    return agentId(raw);
  }

  /** Read all events from a single agent stream and fold them. */
  async function foldAgentStream(id: AgentId): Promise<void> {
    const streamId = agentStreamId(id);
    const result = await backend.read(streamId);
    if (!result.ok) {
      throw new Error(
        `Failed to read agent stream ${streamId} during fold: ${result.error.message}`,
        { cause: result.error },
      );
    }

    // let: state evolves across event sequence
    let state: RegistryEntry | undefined;
    // let: tracks last sequence for optimistic concurrency
    let lastSeq = 0;

    for (const envelope of result.value.events) {
      if (!isAgentStateEvent(envelope.data)) continue;
      state = evolveRegistryEntry(state, envelope.data);
      lastSeq = envelope.sequence;
    }

    if (state !== undefined) {
      projection.set(id, state);
    } else {
      projection.delete(id);
    }
    if (lastSeq > 0) {
      sequenceMap.set(id, lastSeq);
    }
  }

  /** Rebuild the entire projection from the event backend. */
  async function rebuild(): Promise<void> {
    projection.clear();
    sequenceMap.clear();
    knownAgentIds.clear();

    // Read the index stream to discover all agent IDs
    const indexResult = await backend.read(REGISTRY_INDEX_STREAM);
    if (!indexResult.ok) return;

    // Rebuild known agent IDs from the index
    const discoveredIds = new Set<AgentId>();
    for (const envelope of indexResult.value.events) {
      const id = parseIndexAgentId(envelope.data);
      if (id === undefined) continue;

      if (envelope.type === "index:registered") {
        discoveredIds.add(id);
      } else if (envelope.type === "index:deregistered") {
        discoveredIds.delete(id);
      }
    }

    // Fold each agent's stream
    for (const id of discoveredIds) {
      knownAgentIds.add(id);
      await foldAgentStream(id);
    }
  }

  // -------------------------------------------------------------------------
  // AgentRegistry implementation
  // -------------------------------------------------------------------------

  async function register(entry: RegistryEntry): Promise<RegistryEntry> {
    const streamId = agentStreamId(entry.agentId);

    const event: AgentStateEvent = {
      kind: "agent_registered",
      agentId: entry.agentId,
      agentType: entry.agentType,
      parentId: entry.parentId,
      metadata: entry.metadata,
      registeredAt: entry.registeredAt,
    };

    // Append with expectedSequence: 0 — stream must be empty (new agent)
    const appendResult = await backend.append(streamId, {
      type: event.kind,
      data: event,
      expectedSequence: 0,
    });

    if (!appendResult.ok) {
      if (appendResult.error.code === "CONFLICT") {
        // Agent stream already exists — re-register (matches InMemoryRegistry overwrite behavior)
        const currentSeq = sequenceMap.get(entry.agentId) ?? 0;
        const reAppend = await backend.append(streamId, {
          type: event.kind,
          data: event,
          expectedSequence: currentSeq,
        });
        if (!reAppend.ok) {
          throw new Error(
            `Failed to re-register agent ${entry.agentId}: ${reAppend.error.message}`,
            { cause: reAppend.error },
          );
        }
        const evolved = evolveRegistryEntry(undefined, event);
        if (evolved !== undefined) {
          projection.set(entry.agentId, evolved);
          sequenceMap.set(entry.agentId, reAppend.value.sequence);
        }
        knownAgentIds.add(entry.agentId);
        await appendIndexEvent("index:registered", entry.agentId);
        notify({ kind: "registered", entry: evolved ?? entry });
        return evolved ?? entry;
      }
      // Non-CONFLICT backend error — throw to surface infrastructure failure
      throw new Error(
        `Failed to persist agent_registered event for ${entry.agentId}: ${appendResult.error.message}`,
        { cause: appendResult.error },
      );
    }

    const evolved = evolveRegistryEntry(undefined, event);
    if (evolved !== undefined) {
      projection.set(entry.agentId, evolved);
      sequenceMap.set(entry.agentId, appendResult.value.sequence);
    }
    knownAgentIds.add(entry.agentId);
    await appendIndexEvent("index:registered", entry.agentId);
    notify({ kind: "registered", entry: evolved ?? entry });
    return evolved ?? entry;
  }

  async function deregister(id: AgentId): Promise<boolean> {
    const current = projection.get(id);
    if (current === undefined) return false;

    const streamId = agentStreamId(id);
    const currentSeq = sequenceMap.get(id) ?? 0;

    const event: AgentStateEvent = {
      kind: "agent_deregistered",
      agentId: id,
      deregisteredAt: Date.now(),
    };

    const appendResult = await backend.append(streamId, {
      type: event.kind,
      data: event,
      expectedSequence: currentSeq,
    });

    if (appendResult.ok) {
      projection.delete(id);
      sequenceMap.delete(id);
      knownAgentIds.delete(id);
      await appendIndexEvent("index:deregistered", id);
      notify({ kind: "deregistered", agentId: id });
      return true;
    }

    // On CONFLICT: another operation modified the stream concurrently
    // Still deregister from projection (eventual consistency)
    if (appendResult.error.code === "CONFLICT") {
      projection.delete(id);
      sequenceMap.delete(id);
      knownAgentIds.delete(id);
      notify({ kind: "deregistered", agentId: id });
      return true;
    }

    return false;
  }

  function lookup(id: AgentId): RegistryEntry | undefined {
    return projection.get(id);
  }

  function list(filter?: RegistryFilter): readonly RegistryEntry[] {
    const entries = [...projection.values()];
    if (filter === undefined) return entries;
    return entries.filter((e) => matchesFilter(e, filter));
  }

  async function transition(
    id: AgentId,
    targetPhase: ProcessState,
    expectedGeneration: number,
    reason: TransitionReason,
  ): Promise<Result<RegistryEntry, KoiError>> {
    const current = projection.get(id);
    if (current === undefined) {
      return {
        ok: false,
        error: notFound(id, `Agent ${id} not found in registry`),
      };
    }

    // Validate transition + create event
    const eventResult = validateAndApplyTransition(
      current,
      targetPhase,
      expectedGeneration,
      reason,
    );
    if (!eventResult.ok) return eventResult;

    const event = eventResult.value;
    const streamId = agentStreamId(id);
    const currentSeq = sequenceMap.get(id) ?? 0;

    // Append with optimistic concurrency
    const appendResult = await backend.append(streamId, {
      type: event.kind,
      data: event,
      expectedSequence: currentSeq,
    });

    if (!appendResult.ok) {
      // Map backend CONFLICT to registry CONFLICT
      if (appendResult.error.code === "CONFLICT") {
        return {
          ok: false,
          error: conflict(id, `Concurrent modification on agent ${id} — stream sequence mismatch`),
        };
      }
      return { ok: false, error: appendResult.error };
    }

    // Update projection
    const updated = evolveRegistryEntry(current, event);
    if (updated !== undefined) {
      projection.set(id, updated);
      sequenceMap.set(id, appendResult.value.sequence);
    }

    if (event.kind === "agent_transitioned") {
      notify({
        kind: "transitioned",
        agentId: id,
        from: event.from,
        to: event.to,
        generation: event.generation,
        reason: event.reason,
      });
    }

    return updated !== undefined
      ? { ok: true, value: updated }
      : { ok: false, error: notFound(id, `Agent ${id} removed during transition`) };
  }

  function watch(listener: (event: RegistryEvent) => void): () => void {
    listeners = new Set([...listeners, listener]);
    return () => {
      listeners = new Set([...listeners].filter((l) => l !== listener));
    };
  }

  async function dispose(): Promise<void> {
    projection.clear();
    sequenceMap.clear();
    knownAgentIds.clear();
    listeners = new Set();
  }

  // -------------------------------------------------------------------------
  // Startup: rebuild projection from existing events
  // -------------------------------------------------------------------------

  await rebuild();

  return {
    register,
    deregister,
    lookup,
    list,
    transition,
    watch,
    rebuild,
    [Symbol.asyncDispose]: dispose,
  };
}
