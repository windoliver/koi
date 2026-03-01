/**
 * Tool factory for ipc_discover — list live agents available for messaging.
 */

import type {
  AgentRegistry,
  JsonObject,
  ProcessState,
  RegistryFilter,
  Tool,
  TrustTier,
} from "@koi/core";
import { isProcessState } from "@koi/core";

const VALID_AGENT_TYPES: ReadonlySet<string> = new Set(["copilot", "worker"]);

export function createDiscoverTool(
  registry: AgentRegistry,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_discover`,
      description: "List live agents available for messaging.",
      inputSchema: {
        type: "object",
        properties: {
          agentType: {
            type: "string",
            description: "Filter by agent type: copilot or worker",
          },
          phase: {
            type: "string",
            description:
              "Filter by process state: created, running, waiting, suspended, or terminated. Defaults to running.",
          },
        },
        required: [],
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const rawType = args.agentType;
      const rawPhase = args.phase;

      if (
        rawType !== undefined &&
        (typeof rawType !== "string" || !VALID_AGENT_TYPES.has(rawType))
      ) {
        return {
          error: `Invalid agentType: ${String(rawType)}. Must be one of: copilot, worker`,
          code: "VALIDATION",
        };
      }

      if (rawPhase !== undefined && (typeof rawPhase !== "string" || !isProcessState(rawPhase))) {
        return {
          error: `Invalid phase: ${String(rawPhase)}. Must be one of: created, running, waiting, suspended, terminated`,
          code: "VALIDATION",
        };
      }

      const phase: ProcessState = rawPhase !== undefined ? (rawPhase as ProcessState) : "running";

      const filter: RegistryFilter = {
        phase,
        ...(rawType !== undefined ? { agentType: rawType as "copilot" | "worker" } : {}),
      };

      try {
        const entries = await registry.list(filter);
        const agents = entries.map((e) => ({
          agentId: e.agentId,
          agentType: e.agentType,
          phase: e.status.phase,
          registeredAt: e.registeredAt,
        }));
        return { agents };
      } catch (e: unknown) {
        return { error: e instanceof Error ? e.message : String(e), code: "INTERNAL" };
      }
    },
  };
}
