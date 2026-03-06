/**
 * promote_forge — Promotes a brick's scope, trust tier, or lifecycle.
 *
 * Per-field evaluation (Issue 5A): each dimension is validated independently.
 * Scope HITL does NOT block trust or lifecycle changes.
 * Uses VALID_LIFECYCLE_TRANSITIONS for state machine enforcement (Issue 7A).
 * Dedicated error codes: TRUST_DEMOTION_NOT_ALLOWED, LIFECYCLE_INVALID_TRANSITION (Issue 6A).
 * Wires scope promotion to store.promote() if available (Issue 1A).
 */

import type {
  BrickId,
  BrickLifecycle,
  BrickUpdate,
  ForgeScope,
  Result,
  Tool,
  ToolPolicy,
} from "@koi/core";
import { brickId, VALID_LIFECYCLE_TRANSITIONS } from "@koi/core";
import type { ForgeError, ForgePipeline, PromoteChange, PromoteResult } from "@koi/forge-types";
import { governanceError, isVisibleToAgent, storeError } from "@koi/forge-types";
import { z } from "zod";
import type { ForgeDeps, ForgeToolConfig } from "./shared.js";
import { createForgeTool, parseForgeInput } from "./shared.js";

// Pipeline-aware helpers: L2 package uses pipeline (no direct cross-L2 imports)
function getCheckScopePromotion(deps: ForgeDeps): ForgePipeline["checkScopePromotion"] {
  if (deps.pipeline === undefined) {
    throw new Error("ForgePipeline is required in @koi/forge-tools");
  }
  return deps.pipeline.checkScopePromotion;
}

function getValidatePolicyChange(deps: ForgeDeps): ForgePipeline["validatePolicyChange"] {
  if (deps.pipeline === undefined) {
    throw new Error("ForgePipeline is required in @koi/forge-tools");
  }
  return deps.pipeline.validatePolicyChange;
}

// ---------------------------------------------------------------------------
// Zod schema — includes quarantined for remediation path
// ---------------------------------------------------------------------------

const toolPolicySchema = z.object({
  sandbox: z.boolean(),
  capabilities: z.record(z.string(), z.unknown()).optional().default({}),
});

const promoteForgeInputSchema = z
  .object({
    brickId: z.string(),
    targetScope: z.enum(["agent", "zone", "global"]).optional(),
    targetPolicy: toolPolicySchema.optional(),
    targetLifecycle: z
      .enum(["draft", "verifying", "active", "failed", "deprecated", "quarantined"])
      .optional(),
  })
  .refine(
    (val) =>
      val.targetScope !== undefined ||
      val.targetPolicy !== undefined ||
      val.targetLifecycle !== undefined,
    {
      message: "Must specify at least one of: targetScope, targetPolicy, targetLifecycle",
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
      targetPolicy: {
        type: "object",
        properties: {
          sandbox: { type: "boolean" },
          capabilities: { type: "object" },
        },
        required: ["sandbox"],
      },
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
  deps: ForgeDeps,
): Result<ScopeValidation, ForgeError> {
  if (target === current) {
    return { ok: true, value: { change: undefined, requiresHitl: false } };
  }
  const scopeResult = getCheckScopePromotion(deps)(current, target, deps.config);
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
  current: ToolPolicy,
  target: ToolPolicy,
  deps: ForgeDeps,
): Result<PromoteChange<ToolPolicy> | undefined, ForgeError> {
  return getValidatePolicyChange(deps)(current, target, "agent");
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
  const typedBrickId: BrickId = brickId(obj.brickId);

  // Load the brick (returns NOT_FOUND for invisible bricks to avoid leaking existence)
  const loadResult = await deps.store.load(typedBrickId);
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
    const scopeResult = validateScopeChange(brick.scope, obj.targetScope, deps);
    if (!scopeResult.ok) {
      return { ok: false, error: scopeResult.error };
    }
    scopeChange = scopeResult.value.change;
    scopeRequiresHitl = scopeResult.value.requiresHitl;
    scopeHitlMessage = scopeResult.value.hitlMessage;
  }

  // Policy — independent of scope HITL
  let policyChange: PromoteChange<ToolPolicy> | undefined;
  if (obj.targetPolicy !== undefined) {
    const targetPolicy: ToolPolicy = {
      sandbox: obj.targetPolicy.sandbox,
      capabilities: obj.targetPolicy.capabilities ?? {},
    };
    const trustResult = validateTrustChange(brick.policy, targetPolicy, deps);
    if (!trustResult.ok) {
      return { ok: false, error: trustResult.error };
    }
    policyChange = trustResult.value;
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
    policyChange !== undefined ||
    lifecycleChange !== undefined ||
    tagUpdate !== undefined;

  if (hasNonHitlChanges) {
    const updates: BrickUpdate = {
      ...(scopeChange !== undefined ? { scope: scopeChange.to } : {}),
      ...(policyChange !== undefined
        ? { policy: policyChange.to, lastPromotedAt: Date.now() }
        : {}),
      ...(lifecycleChange !== undefined ? { lifecycle: lifecycleChange.to } : {}),
      ...(tagUpdate !== undefined ? { tags: tagUpdate } : {}),
    };

    // Atomic path: promoteAndUpdate() combines scope move + metadata in one operation.
    // Fallback: promote() + update() (non-atomic, legacy).
    // Last resort: update() only (no tier move).
    if (scopeChange !== undefined && deps.store.promoteAndUpdate !== undefined) {
      // Atomic: scope + metadata in one operation (Issue #404)
      const atomicUpdates: BrickUpdate = {
        ...(policyChange !== undefined
          ? { policy: policyChange.to, lastPromotedAt: Date.now() }
          : {}),
        ...(lifecycleChange !== undefined ? { lifecycle: lifecycleChange.to } : {}),
        ...(tagUpdate !== undefined ? { tags: tagUpdate } : {}),
      };
      const result = await deps.store.promoteAndUpdate(typedBrickId, scopeChange.to, atomicUpdates);
      if (!result.ok) {
        return {
          ok: false,
          error: storeError(
            "SAVE_FAILED",
            `Atomic scope promotion failed: ${result.error.message}`,
          ),
        };
      }

      // Fire-and-forget: notify promoted
      if (deps.notifier !== undefined) {
        void Promise.resolve(
          deps.notifier.notify({
            kind: "promoted",
            brickId: typedBrickId,
            scope: scopeChange.to,
          }),
        ).catch(() => {});
      }
    } else if (scopeChange !== undefined && deps.store.promote !== undefined) {
      // Legacy fallback: two-step (non-atomic, kept for backward compat)
      const promoteResult = await deps.store.promote(typedBrickId, scopeChange.to);
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
        ...(policyChange !== undefined
          ? { policy: policyChange.to, lastPromotedAt: Date.now() }
          : {}),
        ...(lifecycleChange !== undefined ? { lifecycle: lifecycleChange.to } : {}),
        ...(tagUpdate !== undefined ? { tags: tagUpdate } : {}),
      };
      const hasNonScopeUpdates =
        policyChange !== undefined || lifecycleChange !== undefined || tagUpdate !== undefined;
      if (hasNonScopeUpdates) {
        const updateResult = await deps.store.update(typedBrickId, nonScopeUpdates);
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
            brickId: typedBrickId,
            scope: scopeChange.to,
          }),
        ).catch(() => {});
      }
    } else {
      // No promote support — update all fields via store.update()
      const updateResult = await deps.store.update(typedBrickId, updates);
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
            brickId: typedBrickId,
            ...(scopeChange !== undefined ? { scope: scopeChange.to } : {}),
          }),
        ).catch(() => {});
      }
    }
  }

  // Build changes record for the result
  const appliedChanges = {
    ...(scopeChange !== undefined ? { scope: scopeChange } : {}),
    ...(policyChange !== undefined ? { policy: policyChange } : {}),
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
        brickId: typedBrickId,
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
      brickId: typedBrickId,
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
