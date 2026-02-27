/**
 * HandoffStore — thin wrapper around Map<HandoffId, HandoffEnvelope>
 * with CAS status transitions and registry-bound cleanup.
 */

import type {
  AgentId,
  AgentRegistry,
  HandoffEnvelope,
  HandoffId,
  HandoffStatus,
  RegistryEvent,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface HandoffStore {
  readonly put: (envelope: HandoffEnvelope) => void;
  readonly get: (id: HandoffId) => HandoffEnvelope | undefined;
  /** CAS status transition. Returns updated envelope or undefined on mismatch. */
  readonly transition: (
    id: HandoffId,
    from: HandoffStatus,
    to: HandoffStatus,
  ) => HandoffEnvelope | undefined;
  readonly listByAgent: (agentId: AgentId) => readonly HandoffEnvelope[];
  readonly remove: (id: HandoffId) => boolean;
  readonly removeByAgent: (agentId: AgentId) => void;
  readonly findPendingForAgent: (agentId: AgentId) => HandoffEnvelope | undefined;
  /** Bind to AgentRegistry — removes envelopes when agents terminate. */
  readonly bindRegistry: (registry: AgentRegistry) => void;
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHandoffStore(): HandoffStore {
  const envelopes = new Map<HandoffId, HandoffEnvelope>();

  // let justified: mutable registry unsubscribe callback
  let registryUnsubscribe: (() => void) | undefined;

  function put(envelope: HandoffEnvelope): void {
    envelopes.set(envelope.id, envelope);
  }

  function get(id: HandoffId): HandoffEnvelope | undefined {
    return envelopes.get(id);
  }

  function transition(
    id: HandoffId,
    from: HandoffStatus,
    to: HandoffStatus,
  ): HandoffEnvelope | undefined {
    const existing = envelopes.get(id);
    if (existing === undefined || existing.status !== from) return undefined;

    const updated: HandoffEnvelope = { ...existing, status: to };
    envelopes.set(id, updated);
    return updated;
  }

  function listByAgent(agentId: AgentId): readonly HandoffEnvelope[] {
    return [...envelopes.values()].filter((e) => e.from === agentId || e.to === agentId);
  }

  function remove(id: HandoffId): boolean {
    return envelopes.delete(id);
  }

  function removeByAgent(agentId: AgentId): void {
    for (const [id, envelope] of envelopes) {
      if (envelope.from === agentId || envelope.to === agentId) {
        envelopes.delete(id);
      }
    }
  }

  function findPendingForAgent(agentId: AgentId): HandoffEnvelope | undefined {
    for (const envelope of envelopes.values()) {
      if (
        envelope.to === agentId &&
        (envelope.status === "pending" || envelope.status === "injected")
      ) {
        return envelope;
      }
    }
    return undefined;
  }

  function bindRegistry(registry: AgentRegistry): void {
    registryUnsubscribe?.();
    registryUnsubscribe = registry.watch((event: RegistryEvent) => {
      if (event.kind === "transitioned" && event.to === "terminated") {
        removeByAgent(event.agentId);
      } else if (event.kind === "deregistered") {
        removeByAgent(event.agentId);
      }
    });
  }

  function dispose(): void {
    registryUnsubscribe?.();
    registryUnsubscribe = undefined;
    envelopes.clear();
  }

  return {
    put,
    get,
    transition,
    listByAgent,
    remove,
    removeByAgent,
    findPendingForAgent,
    bindRegistry,
    dispose,
  };
}
