import type { Agent, AgentRegistry, WritableProcEntry } from "@koi/core";

export function metricsEntry(agent: Agent, registry: AgentRegistry): WritableProcEntry {
  return {
    read: async () => {
      const entry = await registry.lookup(agent.pid.id);
      if (entry === undefined) {
        return undefined;
      }
      return {
        priority: entry.priority,
        generation: entry.status.generation,
        phase: entry.status.phase,
        conditions: entry.status.conditions,
        registeredAt: entry.registeredAt,
      };
    },
    write: async (value: unknown) => {
      // Validate input shape
      if (typeof value !== "object" || value === null) {
        throw new Error("VALIDATION: expected object");
      }

      const obj = value as Record<string, unknown>;

      if (!("priority" in obj)) {
        throw new Error("VALIDATION: missing required field 'priority'");
      }

      const priority = obj.priority;
      if (typeof priority !== "number") {
        throw new Error("VALIDATION: 'priority' must be a number");
      }

      // Attempt patch
      const result = await registry.patch(agent.pid.id, { priority });

      if (!result.ok) {
        throw new Error(`patch failed: ${result.error.message}`);
      }
    },
  };
}
