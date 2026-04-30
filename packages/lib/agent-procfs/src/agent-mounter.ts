import type { Agent, AgentId, AgentRegistry, ProcFs } from "@koi/core";
import { buildAgentEntries, ENTRY_NAMES } from "./entries/index.js";

export type AgentProvider = (agentId: AgentId) => Agent | undefined;

export interface AgentMounterConfig {
  readonly registry: AgentRegistry;
  readonly procFs: ProcFs;
  readonly agentProvider: AgentProvider;
}

export interface AgentMounter {
  readonly dispose: () => void;
}

function pathFor(id: AgentId, name: string): string {
  return `/agents/${id}/${name}`;
}

export function createAgentMounter(config: AgentMounterConfig): AgentMounter {
  const { registry, procFs, agentProvider } = config;
  const mounted = new Set<AgentId>();
  // IDs that have been deregistered (or were never live) — guard against late
  // hydration remounting them after a `deregistered` event.
  const deregistered = new Set<AgentId>();
  let disposed = false;

  function mountAgent(id: AgentId): void {
    if (disposed) return;
    if (deregistered.has(id)) return;
    if (mounted.has(id)) return;
    const agent = agentProvider(id);
    if (agent === undefined) return;
    const entries = buildAgentEntries(agent, registry);
    for (const name of ENTRY_NAMES) {
      procFs.mount(pathFor(id, name), entries[name]);
    }
    mounted.add(id);
  }

  function unmountAgent(id: AgentId): void {
    deregistered.add(id);
    for (const name of ENTRY_NAMES) {
      procFs.unmount(pathFor(id, name));
    }
    mounted.delete(id);
  }

  const unsubscribe = registry.watch((event) => {
    if (disposed) return;
    if (event.kind === "registered") mountAgent(event.entry.agentId);
    else if (event.kind === "deregistered") unmountAgent(event.agentId);
  });

  // Hydrate from existing registry state. Late results respect dispose +
  // any deregistration that arrived via watch() before hydration resolved.
  void (async () => {
    try {
      const existing = await registry.list();
      if (disposed) return;
      for (const entry of existing) mountAgent(entry.agentId);
    } catch {
      // future events via watch() will still arrive
    }
  })();

  return {
    dispose: () => {
      disposed = true;
      unsubscribe();
      for (const id of [...mounted]) unmountAgent(id);
    },
  };
}
