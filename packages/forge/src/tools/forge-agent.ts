/**
 * forge_agent — Stub for agent forging (requires L1 assembly system).
 * Full implementation deferred to follow-up PR.
 */

import type { Tool } from "@koi/core";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import { createForgeTool } from "./shared.js";

const FORGE_AGENT_CONFIG: ForgeToolConfig = {
  name: "forge_agent",
  description: "Creates a new sub-agent (not yet implemented — requires assembly system)",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      manifestYaml: { type: "string" },
    },
    required: ["name", "description", "manifestYaml"],
  },
  handler: async (): Promise<{
    readonly ok: false;
    readonly error: {
      readonly stage: "governance";
      readonly code: "FORGE_DISABLED";
      readonly message: string;
    };
  }> => {
    return {
      ok: false,
      error: {
        stage: "governance",
        code: "FORGE_DISABLED",
        message: "forge_agent is not yet implemented — requires L1 assembly system",
      },
    };
  },
};

export function createForgeAgentTool(deps: ForgeDeps): Tool {
  return createForgeTool(FORGE_AGENT_CONFIG, deps);
}
