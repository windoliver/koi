/**
 * promote_forge — Promotes a brick's scope, trust tier, or lifecycle.
 * Integrates with governance for scope promotion checks and HITL.
 */

import type { BrickLifecycle, BrickUpdate, ForgeScope, Result, Tool, TrustTier } from "@koi/core";
import type { ForgeError } from "../errors.js";
import { governanceError, staticError, storeError, typeError } from "../errors.js";
import { checkScopePromotion } from "../governance.js";
import type { PromoteChange, PromoteResult } from "../types.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import { createForgeTool, validateInputFields } from "./shared.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_SCOPES = new Set<string>(["agent", "zone", "global"]);
const VALID_TRUST_TIERS = new Set<string>(["sandbox", "verified", "promoted"]);
const VALID_LIFECYCLES = new Set<string>(["draft", "verifying", "active", "failed", "deprecated"]);

const TRUST_ORDER: Readonly<Record<TrustTier, number>> = {
  sandbox: 0,
  verified: 1,
  promoted: 2,
} as const;

// ---------------------------------------------------------------------------
// Tool config
// ---------------------------------------------------------------------------

const PROMOTE_FORGE_CONFIG: ForgeToolConfig = {
  name: "promote_forge",
  description: "Promotes a brick's scope, trust tier, or lifecycle state",
  inputSchema: {
    type: "object",
    properties: {
      brickId: { type: "string" },
      targetScope: { type: "string", enum: ["agent", "zone", "global"] },
      targetTrustTier: { type: "string", enum: ["sandbox", "verified", "promoted"] },
      targetLifecycle: { type: "string", enum: ["active", "deprecated", "archived"] },
    },
    required: ["brickId"],
  },
  handler: promoteForgeHandler,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const PROMOTE_FORGE_FIELDS = [
  { name: "brickId", type: "string", required: true },
  { name: "targetScope", type: "string", required: false },
  { name: "targetTrustTier", type: "string", required: false },
  { name: "targetLifecycle", type: "string", required: false },
] as const;

async function promoteForgeHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<Result<PromoteResult, ForgeError>> {
  const validationErr = validateInputFields(input, PROMOTE_FORGE_FIELDS);
  if (validationErr !== undefined) {
    return { ok: false, error: validationErr };
  }

  const obj = input as {
    readonly brickId: string;
    readonly targetScope?: string;
    readonly targetTrustTier?: string;
    readonly targetLifecycle?: string;
  };

  // Must specify at least one promotion target
  if (
    obj.targetScope === undefined &&
    obj.targetTrustTier === undefined &&
    obj.targetLifecycle === undefined
  ) {
    return {
      ok: false,
      error: staticError(
        "MISSING_FIELD",
        "Must specify at least one of: targetScope, targetTrustTier, targetLifecycle",
      ),
    };
  }

  // Validate enum values
  if (obj.targetScope !== undefined && !VALID_SCOPES.has(obj.targetScope)) {
    return {
      ok: false,
      error: typeError(
        `Invalid targetScope "${obj.targetScope}" — must be one of: agent, zone, global`,
      ),
    };
  }
  if (obj.targetTrustTier !== undefined && !VALID_TRUST_TIERS.has(obj.targetTrustTier)) {
    return {
      ok: false,
      error: typeError(
        `Invalid targetTrustTier "${obj.targetTrustTier}" — must be one of: sandbox, verified, promoted`,
      ),
    };
  }
  if (obj.targetLifecycle !== undefined && !VALID_LIFECYCLES.has(obj.targetLifecycle)) {
    return {
      ok: false,
      error: typeError(
        `Invalid targetLifecycle "${obj.targetLifecycle}" — must be one of: draft, verifying, active, failed, deprecated`,
      ),
    };
  }

  // Load the brick
  const loadResult = await deps.store.load(obj.brickId);
  if (!loadResult.ok) {
    return {
      ok: false,
      error: storeError("LOAD_FAILED", `Brick not found: ${obj.brickId}`),
    };
  }

  const brick = loadResult.value;

  // --- Validate scope promotion ---
  let scopeChange: PromoteChange<ForgeScope> | undefined;
  if (obj.targetScope !== undefined) {
    const targetScope = obj.targetScope as ForgeScope;
    if (targetScope !== brick.scope) {
      const scopeResult = checkScopePromotion(
        brick.scope,
        targetScope,
        brick.trustTier,
        deps.config,
      );
      if (!scopeResult.ok) {
        return { ok: false, error: scopeResult.error };
      }
      if (scopeResult.value.requiresHumanApproval) {
        const promoteResult: PromoteResult = {
          brickId: obj.brickId,
          applied: false,
          requiresHumanApproval: true,
          changes: { scope: { from: brick.scope, to: targetScope } },
          ...(scopeResult.value.message !== undefined
            ? { message: scopeResult.value.message }
            : {}),
        };
        return { ok: true, value: promoteResult };
      }
      scopeChange = { from: brick.scope, to: targetScope };
    }
  }

  // --- Validate trust tier promotion ---
  let trustChange: PromoteChange<TrustTier> | undefined;
  if (obj.targetTrustTier !== undefined) {
    const targetTrust = obj.targetTrustTier as TrustTier;
    if (targetTrust !== brick.trustTier) {
      if (TRUST_ORDER[targetTrust] < TRUST_ORDER[brick.trustTier]) {
        return {
          ok: false,
          error: governanceError(
            "SCOPE_VIOLATION",
            `Trust tier demotion not allowed: "${brick.trustTier}" → "${targetTrust}"`,
          ),
        };
      }
      trustChange = { from: brick.trustTier, to: targetTrust };
    }
  }

  // --- Validate lifecycle transition ---
  let lifecycleChange: PromoteChange<BrickLifecycle> | undefined;
  if (obj.targetLifecycle !== undefined) {
    const targetLifecycle = obj.targetLifecycle as BrickLifecycle;
    if (targetLifecycle !== brick.lifecycle) {
      if (brick.lifecycle === "failed") {
        return {
          ok: false,
          error: governanceError(
            "SCOPE_VIOLATION",
            `Cannot transition from "failed" — failed is a terminal state`,
          ),
        };
      }
      lifecycleChange = { from: brick.lifecycle, to: targetLifecycle };
    }
  }

  // Build immutable updates object and apply if any changes exist
  const changes = {
    ...(scopeChange !== undefined ? { scope: scopeChange } : {}),
    ...(trustChange !== undefined ? { trustTier: trustChange } : {}),
    ...(lifecycleChange !== undefined ? { lifecycle: lifecycleChange } : {}),
  };

  const hasChanges =
    scopeChange !== undefined || trustChange !== undefined || lifecycleChange !== undefined;

  if (hasChanges) {
    const updates: BrickUpdate = {
      ...(scopeChange !== undefined ? { scope: scopeChange.to } : {}),
      ...(trustChange !== undefined ? { trustTier: trustChange.to } : {}),
      ...(lifecycleChange !== undefined ? { lifecycle: lifecycleChange.to } : {}),
    };
    const updateResult = await deps.store.update(obj.brickId, updates);
    if (!updateResult.ok) {
      return {
        ok: false,
        error: storeError("SAVE_FAILED", `Failed to update brick: ${updateResult.error.message}`),
      };
    }
  }

  return {
    ok: true,
    value: {
      brickId: obj.brickId,
      applied: true,
      requiresHumanApproval: false,
      changes,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createPromoteForgeTool(deps: ForgeDeps): Tool {
  return createForgeTool(PROMOTE_FORGE_CONFIG, deps);
}
