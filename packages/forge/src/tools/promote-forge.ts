/**
 * promote_forge — Promotes a brick's scope, trust tier, or lifecycle.
 * Integrates with governance for scope promotion checks and HITL.
 */

import type { BrickLifecycle, BrickUpdate, ForgeScope, Result, Tool, TrustTier } from "@koi/core";
import { z } from "zod";
import type { ForgeError } from "../errors.js";
import { governanceError, storeError } from "../errors.js";
import { checkScopePromotion, TRUST_ORDER } from "../governance.js";
import type { PromoteChange, PromoteResult } from "../types.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import { createForgeTool, parseForgeInput } from "./shared.js";

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const promoteForgeInputSchema = z
  .object({
    brickId: z.string(),
    targetScope: z.enum(["agent", "zone", "global"]).optional(),
    targetTrustTier: z.enum(["sandbox", "verified", "promoted"]).optional(),
    targetLifecycle: z.enum(["draft", "verifying", "active", "failed", "deprecated"]).optional(),
  })
  .refine(
    (val) =>
      val.targetScope !== undefined ||
      val.targetTrustTier !== undefined ||
      val.targetLifecycle !== undefined,
    {
      message: "Must specify at least one of: targetScope, targetTrustTier, targetLifecycle",
    },
  );

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

async function promoteForgeHandler(
  input: unknown,
  deps: ForgeDeps,
): Promise<Result<PromoteResult, ForgeError>> {
  const parsed = parseForgeInput(promoteForgeInputSchema, input);
  if (!parsed.ok) {
    return parsed;
  }

  const obj = parsed.value;

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
    const targetScope: ForgeScope = obj.targetScope;
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
    const targetTrust: TrustTier = obj.targetTrustTier;
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
    const targetLifecycle: BrickLifecycle = obj.targetLifecycle;
    if (targetLifecycle !== brick.lifecycle) {
      if (brick.lifecycle === "failed") {
        return {
          ok: false,
          error: governanceError(
            "SCOPE_VIOLATION",
            'Cannot transition from "failed" — failed is a terminal state',
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
