/**
 * Agent mounter — watches registry and mounts/unmounts procfs entries per agent.
 *
 * On register: mounts all entries under /agents/<agentId>/ via data-driven factory.
 * On deregister: unmounts all entries for that agent.
 */

import type { Agent, AgentId, AgentRegistry, ProcFs } from "@koi/core";
import { PROCFS_ENTRIES } from "./entry-definitions.js";
import { createEntriesFromDefinitions } from "./entry-factory.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Resolves an AgentId to an Agent entity for component reads. */
export type AgentProvider = (agentId: AgentId) => Agent | undefined;

export interface AgentMounterConfig {
  readonly registry: AgentRegistry;
  readonly procFs: ProcFs;
  readonly agentProvider: AgentProvider;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentPath(agentId: AgentId, suffix: string): string {
  return `/agents/${agentId}/${suffix}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface AgentMounter {
  /** Stop watching registry events. */
  readonly dispose: () => void;
}

export function createAgentMounter(config: AgentMounterConfig): AgentMounter {
  const { registry, procFs, agentProvider } = config;

  function mountAgent(agentId: AgentId): void {
    const agent = agentProvider(agentId);
    if (agent === undefined) return;

    const entries = createEntriesFromDefinitions(PROCFS_ENTRIES, {
      agent,
      agentId,
      registry,
    });
    for (const { path, entry } of entries) {
      procFs.mount(agentPath(agentId, path), entry);
    }
  }

  function unmountAgent(agentId: AgentId): void {
    for (const def of PROCFS_ENTRIES) {
      procFs.unmount(agentPath(agentId, def.path));
    }
  }

  // Watch for registry changes
  const unsubscribe = registry.watch((event) => {
    switch (event.kind) {
      case "registered":
        mountAgent(event.entry.agentId);
        break;
      case "deregistered":
        unmountAgent(event.agentId);
        break;
    }
  });

  return {
    dispose: unsubscribe,
  };
}
