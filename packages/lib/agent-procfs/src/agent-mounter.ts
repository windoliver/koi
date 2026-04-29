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

  function mountAgent(id: AgentId): void {
    const agent = agentProvider(id);
    if (agent === undefined) return;
    const entries = buildAgentEntries(agent, registry);
    for (const name of ENTRY_NAMES) {
      procFs.mount(pathFor(id, name), entries[name]);
    }
  }

  function unmountAgent(id: AgentId): void {
    for (const name of ENTRY_NAMES) {
      procFs.unmount(pathFor(id, name));
    }
  }

  // Hydrate from existing registry state — best effort, fire-and-forget.
  void (async () => {
    try {
      const existing = await registry.list();
      for (const entry of existing) mountAgent(entry.agentId);
    } catch {
      // future events via watch() will still arrive
    }
  })();

  const unsubscribe = registry.watch((event) => {
    if (event.kind === "registered") mountAgent(event.entry.agentId);
    else if (event.kind === "deregistered") unmountAgent(event.agentId);
  });

  return { dispose: unsubscribe };
}
