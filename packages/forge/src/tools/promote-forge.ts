/**
 * promote_forge — Promotes a brick's scope, trust tier, or lifecycle.
 *
 * Per-field evaluation (Issue 5A): each dimension is validated independently.
 * Scope HITL does NOT block trust or lifecycle changes.
 * Uses VALID_LIFECYCLE_TRANSITIONS for state machine enforcement (Issue 7A).
 * Dedicated error codes: TRUST_DEMOTION_NOT_ALLOWED, LIFECYCLE_INVALID_TRANSITION (Issue 6A).
 * Wires scope promotion to store.promote() if available (Issue 1A).
 */

import type { BrickLifecycle, BrickUpdate, ForgeScope, Result, Tool, TrustTier } from "@koi/core";
import { VALID_LIFECYCLE_TRANSITIONS } from "@koi/core";
import { z } from "zod";
import type { ForgeError } from "../errors.js";
import { governanceError, storeError } from "../errors.js";
import { checkScopePromotion, TRUST_ORDER } from "../governance.js";
import { isVisibleToAgent } from "../scope-filter.js";
import type { PromoteChange, PromoteResult } from "../types.js";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import { createForgeTool, parseForgeInput } from "./shared.js";

// ---------------------------------------------------------------------------
// Zod schema — includes quarantined for remediation path
// ---------------------------------------------------------------------------

const promoteForgeInputSchema = z
  .object({
    brickId: z.string(),
    targetScope: z.enum(["agent", "zone", "global"]).optional(),
    targetTrustTier: z.enum(["sandbox", "verified", "promoted"]).optional(),
    targetLifecycle: z
      .enum(["draft", "verifying", "active", "failed", "deprecated", "quarantined"])
      .optional(),
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
      targetLifecycle: {
        type: "string",
        enum: ["draft", "verifying", "active", "failed", "deprecated", "quarantined"],
      },
    },
    required: ["brickId"],
  },
  handler: promoteForgeHandler,
};

// ---------------------------------------------------------------------------
// Per-field validators (pure functions returning change or error)
// ---------------------------------------------------------------------------

interface ScopeValidation {
  readonly change: PromoteChange<ForgeScope> | undefined;
  readonly requiresHitl: boolean;
  readonly hitlMessage?: string | undefined;
}

function validateScopeChange(
  current: ForgeScope,
  target: ForgeScope,
  trustTier: TrustTier,
  deps: ForgeDeps,
): Result<ScopeValidation, ForgeError> {
  if (target === current) {
    return { ok: true, value: { change: undefined, requiresHitl: false } };
  }
  const scopeResult = checkScopePromotion(current, target, trustTier, deps.config);
  if (!scopeResult.ok) {
    return { ok: false, error: scopeResult.error };
  }
  if (scopeResult.value.requiresHumanApproval) {
    return {
      ok: true,
      value: { change: undefined, requiresHitl: true, hitlMessage: scopeResult.value.message },
    };
  }
  return { ok: true, value: { change: { from: current, to: target }, requiresHitl: false } };
}

function validateTrustChange(
  current: TrustTier,
  target: TrustTier,
): Result<PromoteChange<TrustTier> | undefined, ForgeError> {
  if (target === current) {
    return { ok: true, value: undefined };
  }
  if (TRUST_ORDER[target] < TRUST_ORDER[current]) {
    return {
      ok: false,
      error: governanceError(
        "TRUST_DEMOTION_NOT_ALLOWED",
        `Trust tier demotion not allowed: "${current}" → "${target}"`,
      ),
    };
  }
  return { ok: true, value: { from: current, to: target } };
}

function validateLifecycleChange(
  current: BrickLifecycle,
  target: BrickLifecycle,
): Result<PromoteChange<BrickLifecycle> | undefined, ForgeError> {
  if (target === current) {
    return { ok: true, value: undefined };
  }
  const allowed = VALID_LIFECYCLE_TRANSITIONS[current];
  if (!allowed.includes(target)) {
    return {
      ok: false,
      error: governanceError(
        "LIFECYCLE_INVALID_TRANSITION",
        `Invalid lifecycle transition: "${current}" → "${target}". Allowed: [${allowed.join(", ")}]`,
      ),
    };
  }
  return { ok: true, value: { from: current, to: target } };
}

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

  // Load the brick (returns NOT_FOUND for invisible bricks to avoid leaking existence)
  const loadResult = await deps.store.load(obj.brickId);
  if (!loadResult.ok) {
    return {
      ok: false,
      error: storeError("LOAD_FAILED", `Brick not found: ${obj.brickId}`),
    };
  }

  if (!isVisibleToAgent(loadResult.value, deps.context.agentId)) {
    return {
      ok: false,
      error: storeError("LOAD_FAILED", `Brick not found: ${obj.brickId}`),
    };
  }

  const brick = loadResult.value;

  // --- Per-field validation (Issue 5A) ---
  // Each dimension is evaluated independently. Scope HITL does NOT block other fields.

  let scopeChange: PromoteChange<ForgeScope> | undefined;
  let scopeRequiresHitl = false;
  let scopeHitlMessage: string | undefined;

  if (obj.targetScope !== undefined) {
    const scopeResult = validateScopeChange(brick.scope, obj.targetScope, brick.trustTier, deps);
    if (!scopeResult.ok) {
      return { ok: false, error: scopeResult.error };
    }
    scopeChange = scopeResult.value.change;
    scopeRequiresHitl = scopeResult.value.requiresHitl;
    scopeHitlMessage = scopeResult.value.hitlMessage;
  }

  // Trust tier — independent of scope HITL
  let trustChange: PromoteChange<TrustTier> | undefined;
  if (obj.targetTrustTier !== undefined) {
    const trustResult = validateTrustChange(brick.trustTier, obj.targetTrustTier);
    if (!trustResult.ok) {
      return { ok: false, error: trustResult.error };
    }
    trustChange = trustResult.value;
  }

  // Lifecycle — independent of scope HITL
  let lifecycleChange: PromoteChange<BrickLifecycle> | undefined;
  if (obj.targetLifecycle !== undefined) {
    const lifecycleResult = validateLifecycleChange(brick.lifecycle, obj.targetLifecycle);
    if (!lifecycleResult.ok) {
      return { ok: false, error: lifecycleResult.error };
    }
    lifecycleChange = lifecycleResult.value;
  }

  // --- Auto-assign zone tag when promoting to zone scope (Issue C2) ---
  // If scope changes to "zone" and zoneId is available, ensure zone:<zoneId> tag exists
  let tagUpdate: readonly string[] | undefined;
  if (scopeChange !== undefined && scopeChange.to === "zone" && deps.context.zoneId !== undefined) {
    const zoneTag = `zone:${deps.context.zoneId}`;
    if (!brick.tags.includes(zoneTag)) {
      tagUpdate = [...brick.tags, zoneTag];
    }
  }

  // --- Apply non-HITL changes (trust + lifecycle always, scope only if not gated) ---
  const hasNonHitlChanges =
    scopeChange !== undefined ||
    trustChange !== undefined ||
    lifecycleChange !== undefined ||
    tagUpdate !== undefined;

  if (hasNonHitlChanges) {
    const updates: BrickUpdate = {
      ...(scopeChange !== undefined ? { scope: scopeChange.to } : {}),
      ...(trustChange !== undefined ? { trustTier: trustChange.to } : {}),
      ...(lifecycleChange !== undefined ? { lifecycle: lifecycleChange.to } : {}),
      ...(tagUpdate !== undefined ? { tags: tagUpdate } : {}),
    };

    // Wire scope promotion to store.promote() if available (Issue 1A)
    // NOTE: promote() + update() are NOT atomic. If update() fails after promote()
    // succeeds, the brick is in the new tier with stale trust/lifecycle metadata.
    if (scopeChange !== undefined && deps.store.promote !== undefined) {
      const promoteResult = await deps.store.promote(obj.brickId, scopeChange.to);
      if (!promoteResult.ok) {
        return {
          ok: false,
          error: storeError(
            "SAVE_FAILED",
            `Scope promotion failed: ${promoteResult.error.message}`,
          ),
        };
      }
      // Apply remaining non-scope updates if any (includes zone tag assignment)
      const nonScopeUpdates: BrickUpdate = {
        ...(trustChange !== undefined ? { trustTier: trustChange.to } : {}),
        ...(lifecycleChange !== undefined ? { lifecycle: lifecycleChange.to } : {}),
        ...(tagUpdate !== undefined ? { tags: tagUpdate } : {}),
      };
      const hasNonScopeUpdates =
        trustChange !== undefined || lifecycleChange !== undefined || tagUpdate !== undefined;
      if (hasNonScopeUpdates) {
        const updateResult = await deps.store.update(obj.brickId, nonScopeUpdates);
        if (!updateResult.ok) {
          return {
            ok: false,
            error: storeError(
              "SAVE_FAILED",
              `Failed to update brick: ${updateResult.error.message}`,
            ),
          };
        }
      }

      // Fire-and-forget: notify promoted
      if (deps.notifier !== undefined) {
        void Promise.resolve(
          deps.notifier.notify({
            kind: "promoted",
            brickId: obj.brickId,
            scope: scopeChange.to,
          }),
        ).catch(() => {});
      }
    } else {
      // No store.promote — update all fields via store.update()
      const updateResult = await deps.store.update(obj.brickId, updates);
      if (!updateResult.ok) {
        return {
          ok: false,
          error: storeError("SAVE_FAILED", `Failed to update brick: ${updateResult.error.message}`),
        };
      }

      // Fire-and-forget: notify updated
      if (deps.notifier !== undefined) {
        void Promise.resolve(
          deps.notifier.notify({
            kind: "updated",
            brickId: obj.brickId,
            ...(scopeChange !== undefined ? { scope: scopeChange.to } : {}),
          }),
        ).catch(() => {});
      }
    }
  }

  // Build changes record for the result
  const appliedChanges = {
    ...(scopeChange !== undefined ? { scope: scopeChange } : {}),
    ...(trustChange !== undefined ? { trustTier: trustChange } : {}),
    ...(lifecycleChange !== undefined ? { lifecycle: lifecycleChange } : {}),
  };

  // If scope is HITL-gated but other changes were applied, report partial
  if (scopeRequiresHitl) {
    const pendingScopeChange: PromoteChange<ForgeScope> = {
      from: brick.scope,
      to: obj.targetScope as ForgeScope,
    };
    return {
      ok: true,
      value: {
        brickId: obj.brickId,
        applied: hasNonHitlChanges,
        requiresHumanApproval: true,
        changes: {
          ...appliedChanges,
          scope: pendingScopeChange,
        },
        ...(scopeHitlMessage !== undefined ? { message: scopeHitlMessage } : {}),
      },
    };
  }

  return {
    ok: true,
    value: {
      brickId: obj.brickId,
      applied: true,
      requiresHumanApproval: false,
      changes: appliedChanges,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createPromoteForgeTool(deps: ForgeDeps): Tool {
  return createForgeTool(PROMOTE_FORGE_CONFIG, deps);
}
