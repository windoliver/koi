/**
 * promote_forge — Stub for scope/trust promotion.
 * Full implementation deferred to follow-up PR (requires HITL integration).
 */

import type { Tool } from "@koi/core";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import { createForgeTool } from "./shared.js";

const PROMOTE_FORGE_CONFIG: ForgeToolConfig = {
  name: "promote_forge",
  description: "Promotes a brick's scope or trust tier (not yet implemented — requires HITL)",
  inputSchema: {
    type: "object",
    properties: {
      brickId: { type: "string" },
      targetScope: { type: "string" },
      targetTrustTier: { type: "string" },
    },
    required: ["brickId"],
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
        message: "promote_forge is not yet implemented — requires HITL integration",
      },
    };
  },
};

export function createPromoteForgeTool(deps: ForgeDeps): Tool {
  return createForgeTool(PROMOTE_FORGE_CONFIG, deps);
}
