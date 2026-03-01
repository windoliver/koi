/**
 * Agent mounter — watches registry and mounts/unmounts procfs entries per agent.
 *
 * On register: mounts 7 entries under /agents/<agentId>/
 * On deregister: unmounts all entries for that agent.
 */

import type { Agent, AgentId, AgentRegistry, ProcFs } from "@koi/core";
import { createChildrenEntry } from "./entries/children.js";
import { createConfigEntry } from "./entries/config.js";
import { createEnvEntry } from "./entries/env.js";
import { createMetricsEntry } from "./entries/metrics.js";
import { createMiddlewareEntry } from "./entries/middleware.js";
import { createStatusEntry } from "./entries/status.js";
import { createToolsEntry } from "./entries/tools.js";

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
// Entry paths per agent
// ---------------------------------------------------------------------------

const ENTRY_SUFFIXES = [
  "status",
  "metrics",
  "tools",
  "middleware",
  "children",
  "config",
  "env",
] as const;

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

    procFs.mount(agentPath(agentId, "status"), createStatusEntry(agent));
    procFs.mount(agentPath(agentId, "metrics"), createMetricsEntry(agentId, registry));
    procFs.mount(agentPath(agentId, "tools"), createToolsEntry(agent));
    procFs.mount(agentPath(agentId, "middleware"), createMiddlewareEntry(agent));
    procFs.mount(agentPath(agentId, "children"), createChildrenEntry(agentId, registry));
    procFs.mount(agentPath(agentId, "config"), createConfigEntry(agent));
    procFs.mount(agentPath(agentId, "env"), createEnvEntry(agent));
  }

  function unmountAgent(agentId: AgentId): void {
    for (const suffix of ENTRY_SUFFIXES) {
      procFs.unmount(agentPath(agentId, suffix));
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
