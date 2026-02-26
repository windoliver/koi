/**
 * Governance — depth-aware forge policies and scope promotion checks.
 */

import type { GovernanceController, Result, TrustTier } from "@koi/core";
import { GOVERNANCE_VARIABLES } from "@koi/core";
import type { ForgeConfig } from "./config.js";
import type { ForgeError } from "./errors.js";
import { governanceError } from "./errors.js";
import type { ForgeContext, ForgeScope } from "./types.js";

// ---------------------------------------------------------------------------
// Trust tier ordering (for comparison)
// ---------------------------------------------------------------------------

export const TRUST_ORDER: Readonly<Record<TrustTier, number>> = {
  sandbox: 0,
  verified: 1,
  promoted: 2,
} as const;

const SCOPE_ORDER: Readonly<Record<ForgeScope, number>> = {
  agent: 0,
  zone: 1,
  global: 2,
} as const;

// ---------------------------------------------------------------------------
// Governance check result for HITL
// ---------------------------------------------------------------------------

export interface GovernanceResult {
  readonly requiresHumanApproval: boolean;
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Depth-aware tool filtering (per architecture doc)
// ---------------------------------------------------------------------------

/** Depth 0 (root): all 6 primordial tools */
const DEPTH_0_TOOLS = new Set([
  "forge_tool",
  "forge_skill",
  "forge_agent",
  "search_forge",
  "compose_forge",
  "promote_forge",
]);

/** Depth 1 (sub-agent): limited set */
const DEPTH_1_TOOLS = new Set(["forge_tool", "forge_skill", "search_forge", "promote_forge"]);

/** Depth 2+ (deeper): search only */
const DEPTH_2_TOOLS = new Set(["search_forge"]);

function getAllowedToolsForDepth(depth: number): ReadonlySet<string> {
  if (depth <= 0) return DEPTH_0_TOOLS;
  if (depth === 1) return DEPTH_1_TOOLS;
  return DEPTH_2_TOOLS;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check forge governance with optional controller delegation.
 *
 * When a GovernanceController is provided, forge_depth and forge_budget
 * checks delegate to the unified controller. The controller path returns
 * the first failing GovernanceCheck or `{ ok: true }`.
 *
 * When no controller is provided (backward compat), uses standalone
 * ForgeContext-based logic.
 *
 * Depth-aware tool filtering and config.enabled always use local logic
 * regardless of controller presence.
 */
export function checkGovernance(
  context: ForgeContext,
  config: ForgeConfig,
  toolName?: string | undefined,
  controller?: GovernanceController | undefined,
): Result<void, ForgeError> | Promise<Result<void, ForgeError>> {
  if (!config.enabled) {
    return {
      ok: false,
      error: governanceError("FORGE_DISABLED", "Forge is disabled in configuration"),
    };
  }

  // Delegate depth + budget checks to controller when present
  if (controller !== undefined) {
    return checkGovernanceViaController(controller, context, toolName);
  }

  // Standalone path (backward compat) — preserves original check ordering
  if (context.depth > config.maxForgeDepth) {
    return {
      ok: false,
      error: governanceError(
        "MAX_DEPTH",
        `Forge depth ${context.depth} exceeds max ${config.maxForgeDepth}`,
      ),
    };
  }

  if (context.forgesThisSession >= config.maxForgesPerSession) {
    return {
      ok: false,
      error: governanceError(
        "MAX_SESSION_FORGES",
        `Session has reached max forges (${config.maxForgesPerSession})`,
      ),
    };
  }

  // Depth-aware tool filtering (only applies to known primordial tools)
  if (toolName !== undefined && DEPTH_0_TOOLS.has(toolName)) {
    const allowed = getAllowedToolsForDepth(context.depth);
    if (!allowed.has(toolName)) {
      return {
        ok: false,
        error: governanceError(
          "DEPTH_TOOL_RESTRICTED",
          `Tool "${toolName}" is not allowed at depth ${context.depth}`,
        ),
      };
    }
  }

  return { ok: true, value: undefined };
}

async function checkGovernanceViaController(
  controller: GovernanceController,
  context: ForgeContext,
  toolName?: string | undefined,
): Promise<Result<void, ForgeError>> {
  const depthCheck = await controller.check(GOVERNANCE_VARIABLES.FORGE_DEPTH);
  if (!depthCheck.ok) {
    return {
      ok: false,
      error: governanceError("MAX_DEPTH", depthCheck.reason),
    };
  }

  const budgetCheck = await controller.check(GOVERNANCE_VARIABLES.FORGE_BUDGET);
  if (!budgetCheck.ok) {
    return {
      ok: false,
      error: governanceError("MAX_SESSION_FORGES", budgetCheck.reason),
    };
  }

  // Depth-aware tool filtering (always local — controller doesn't own tool policy)
  if (toolName !== undefined && DEPTH_0_TOOLS.has(toolName)) {
    const allowed = getAllowedToolsForDepth(context.depth);
    if (!allowed.has(toolName)) {
      return {
        ok: false,
        error: governanceError(
          "DEPTH_TOOL_RESTRICTED",
          `Tool "${toolName}" is not allowed at depth ${context.depth}`,
        ),
      };
    }
  }

  return { ok: true, value: undefined };
}

export function checkScopePromotion(
  currentScope: ForgeScope,
  targetScope: ForgeScope,
  trustTier: TrustTier,
  config: ForgeConfig,
): Result<GovernanceResult, ForgeError> {
  // No promotion needed if target is same or lower scope
  if (SCOPE_ORDER[targetScope] <= SCOPE_ORDER[currentScope]) {
    return { ok: true, value: { requiresHumanApproval: false } };
  }

  // Zone promotion
  if (targetScope === "zone") {
    const minTrust = config.scopePromotion.minTrustForZone;
    if (TRUST_ORDER[trustTier] < TRUST_ORDER[minTrust]) {
      return {
        ok: false,
        error: governanceError(
          "SCOPE_VIOLATION",
          `Zone promotion requires trust tier "${minTrust}" or higher, got "${trustTier}"`,
        ),
      };
    }
  }

  // Global promotion
  if (targetScope === "global") {
    const minTrust = config.scopePromotion.minTrustForGlobal;
    if (TRUST_ORDER[trustTier] < TRUST_ORDER[minTrust]) {
      return {
        ok: false,
        error: governanceError(
          "SCOPE_VIOLATION",
          `Global promotion requires trust tier "${minTrust}" or higher, got "${trustTier}"`,
        ),
      };
    }
  }

  // Check if HITL is required
  if (config.scopePromotion.requireHumanApproval) {
    return {
      ok: true,
      value: {
        requiresHumanApproval: true,
        message: `Scope promotion from "${currentScope}" to "${targetScope}" requires human approval`,
      },
    };
  }

  return { ok: true, value: { requiresHumanApproval: false } };
}
