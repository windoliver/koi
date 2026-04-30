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
      if (typeof value !== "object" || value === null || !("priority" in value)) {
        throw new Error("VALIDATION: expected { priority: number }");
      }
      const { priority } = value;
      if (
        typeof priority !== "number" ||
        !Number.isInteger(priority) ||
        priority < 0 ||
        priority > 39
      ) {
        throw new Error("VALIDATION: 'priority' must be an integer in [0, 39]");
      }
      const result = await registry.patch(agent.pid.id, { priority });
      if (!result.ok) {
        throw new Error(`patch failed: ${result.error.message}`);
      }
    },
  };
}
