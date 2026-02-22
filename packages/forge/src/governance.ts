/**
 * Governance — depth-aware forge policies and scope promotion checks.
 */

import type { Result, TrustTier } from "@koi/core";
import type { ForgeConfig } from "./config.js";
import type { ForgeError } from "./errors.js";
import { governanceError } from "./errors.js";
import type { ForgeContext, ForgeScope } from "./types.js";

// ---------------------------------------------------------------------------
// Trust tier ordering (for comparison)
// ---------------------------------------------------------------------------

const TRUST_ORDER: Readonly<Record<TrustTier, number>> = {
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
// Public API
// ---------------------------------------------------------------------------

export function checkGovernance(
  context: ForgeContext,
  config: ForgeConfig,
): Result<void, ForgeError> {
  if (!config.enabled) {
    return {
      ok: false,
      error: governanceError("FORGE_DISABLED", "Forge is disabled in configuration"),
    };
  }

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
