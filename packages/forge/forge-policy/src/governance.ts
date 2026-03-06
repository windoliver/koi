/**
 * Governance — depth-aware forge policies and scope promotion checks.
 */

import type { GovernanceController, Result, ToolPolicy, TrustTransitionCaller } from "@koi/core";
import { GOVERNANCE_VARIABLES } from "@koi/core";
import type {
  ForgeConfig,
  ForgeContext,
  ForgeError,
  ForgeScope,
  GovernanceResult,
  PromoteChange,
} from "@koi/forge-types";
import { governanceError } from "@koi/forge-types";

// Re-export GovernanceResult for backward compatibility
export type { GovernanceResult } from "@koi/forge-types";

// ---------------------------------------------------------------------------
// Scope ordering (for comparison)
// ---------------------------------------------------------------------------

const SCOPE_ORDER: Readonly<Record<ForgeScope, number>> = {
  agent: 0,
  zone: 1,
  global: 2,
} as const;

// ---------------------------------------------------------------------------
// Depth-aware tool filtering (per architecture doc)
// ---------------------------------------------------------------------------

/** Depth 0 (root): all primordial tools + forge_edit */
const DEPTH_0_TOOLS = new Set([
  "forge_tool",
  "forge_skill",
  "forge_agent",
  "forge_edit",
  "search_forge",
  "compose_forge",
  "update_forge",
]);

/** Depth 1 (sub-agent): limited set */
const DEPTH_1_TOOLS = new Set([
  "forge_tool",
  "forge_skill",
  "forge_edit",
  "search_forge",
  "update_forge",
]);

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

/**
 * Check scope promotion eligibility.
 *
 * Scope promotion is orthogonal to sandbox policy. The only check is
 * whether human approval is required.
 */
export function checkScopePromotion(
  currentScope: ForgeScope,
  targetScope: ForgeScope,
  config: ForgeConfig,
): Result<GovernanceResult, ForgeError> {
  // No promotion needed if target is same or lower scope
  if (SCOPE_ORDER[targetScope] <= SCOPE_ORDER[currentScope]) {
    return { ok: true, value: { requiresHumanApproval: false } };
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

// ---------------------------------------------------------------------------
// Policy change validation
// ---------------------------------------------------------------------------

/**
 * Validates a policy change.
 *
 * - Unsandboxing (sandbox: true→false) requires HITL unless caller is "system"
 * - Re-sandboxing (sandbox: false→true) is always allowed
 * - No change → returns undefined
 */
export function validatePolicyChange(
  current: ToolPolicy,
  target: ToolPolicy,
  caller: TrustTransitionCaller,
): Result<PromoteChange<ToolPolicy> | undefined, ForgeError> {
  if (current.sandbox === target.sandbox) {
    return { ok: true, value: undefined };
  }

  // Re-sandboxing (false→true) is always allowed
  if (target.sandbox) {
    return { ok: true, value: { from: current, to: target } };
  }

  // Unsandboxing (true→false) — only system caller can unsandbox
  if (caller === "agent") {
    return {
      ok: false,
      error: governanceError(
        "TRUST_DEMOTION_NOT_ALLOWED",
        "Unsandboxing requires system-level authorization, not agent-level",
      ),
    };
  }

  return { ok: true, value: { from: current, to: target } };
}
