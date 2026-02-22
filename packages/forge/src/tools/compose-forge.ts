/**
 * compose_forge — Stub for brick composition.
 * Full implementation deferred to follow-up PR.
 */

import type { Tool } from "@koi/core";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import { createForgeTool } from "./shared.js";

const COMPOSE_FORGE_CONFIG: ForgeToolConfig = {
  name: "compose_forge",
  description: "Composes multiple bricks into a composite (not yet implemented)",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      brickIds: { type: "array", items: { type: "string" } },
    },
    required: ["name", "description", "brickIds"],
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
        message: "compose_forge is not yet implemented — requires brick composition logic",
      },
    };
  },
};

export function createComposeForgeTool(deps: ForgeDeps): Tool {
  return createForgeTool(COMPOSE_FORGE_CONFIG, deps);
}
