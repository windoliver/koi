/**
 * /agents/<id>/metrics — read agent metrics from registry entry.
 */

import type { AgentId, AgentRegistry, WritableProcEntry } from "@koi/core";

export function createMetricsEntry(agentId: AgentId, registry: AgentRegistry): WritableProcEntry {
  return {
    read: async () => {
      const entry = await registry.lookup(agentId);
      if (entry === undefined) return undefined;
      return {
        priority: entry.priority,
        generation: entry.status.generation,
        phase: entry.status.phase,
        conditions: entry.status.conditions,
        registeredAt: entry.registeredAt,
      };
    },
    write: async (value: unknown) => {
      // Only support priority updates via procfs write
      if (typeof value === "object" && value !== null && "priority" in value) {
        const priority = (value as Readonly<Record<string, unknown>>).priority;
        if (typeof priority === "number") {
          await registry.patch(agentId, { priority });
        }
      }
    },
  };
}
