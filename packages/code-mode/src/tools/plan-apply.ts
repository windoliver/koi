/**
 * code_plan_apply tool — Applies a pending plan with rollback on failure.
 *
 * Re-reads files to check staleness, then applies all steps.
 * On any failure, rolls back previously applied steps in LIFO order.
 */

import type { FileSystemBackend, JsonObject, Tool, TrustTier } from "@koi/core";
import { parseOptionalString } from "../parse-args.js";
import type { PlanStore } from "../plan-store.js";
import type { ApplyResult, CodePlan, CodePlanStep, StepResult } from "../types.js";
import { validateStaleness } from "../validation.js";

// ─── Snapshot for rollback ────────────────────────────────────────────────

interface FileSnapshot {
  readonly stepIndex: number;
  readonly path: string;
  readonly kind: "created" | "modified" | "deleted" | "renamed";
  readonly previousContent?: string;
  readonly renamedTo?: string;
}

export function createPlanApplyTool(
  backend: FileSystemBackend,
  store: PlanStore,
  prefix: string,
  trustTier: TrustTier,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_apply`,
      description:
        "Apply the current pending code plan. Optionally pass planId to confirm the right plan is being applied.",
      inputSchema: {
        type: "object",
        properties: {
          planId: {
            type: "string",
            description: "Optional plan ID for confirmation",
          },
        },
      } as JsonObject,
    },
    trustTier,
    execute: async (args: JsonObject): Promise<unknown> => {
      const planIdResult = parseOptionalString(args, "planId");
      if (!planIdResult.ok) return planIdResult.err;

      const plan = store.get();
      if (plan === undefined) {
        return { error: "No active plan. Use code_plan_create first.", code: "NOT_FOUND" };
      }

      if (plan.state === "applied") {
        return { error: "Plan already applied", code: "CONFLICT" };
      }

      if (plan.state === "failed") {
        return { error: "Plan has failed. Create a new plan.", code: "CONFLICT" };
      }

      if (planIdResult.value !== undefined && planIdResult.value !== plan.id) {
        return {
          error: `Plan ID mismatch: expected ${plan.id}, got ${planIdResult.value}`,
          code: "CONFLICT",
        };
      }

      // Re-read files to check staleness
      const stalenessCheck = await checkStaleness(backend, plan);
      if (!stalenessCheck.ok) {
        store.update(plan.id, { state: "failed" });
        return stalenessCheck.error;
      }

      // Apply each step with rollback support
      const { stepResults, snapshots, failedAtIndex } = await applyStepsWithSnapshots(
        backend,
        plan,
      );
      const allSuccess = failedAtIndex === -1;
      const needsRollback = !allSuccess && snapshots.length > 0;

      const rollbackErrors: readonly string[] = needsRollback
        ? await rollbackSteps(backend, snapshots)
        : [];
      const rolledBack = needsRollback;

      if (!allSuccess) {
        store.update(plan.id, { state: "failed" });
      } else {
        store.update(plan.id, { state: "applied" });
      }

      const result: ApplyResult = {
        planId: plan.id,
        success: allSuccess,
        steps: stepResults,
        rolledBack,
        rollbackErrors,
      };
      return result;
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

type StalenessResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: {
        readonly error: string;
        readonly code: string;
        readonly issues: readonly unknown[];
      };
    };

async function checkStaleness(
  backend: FileSystemBackend,
  plan: CodePlan,
): Promise<StalenessResult> {
  if (plan.hashes.length === 0) return { ok: true };

  const currentContents = new Map<string, string>();
  for (const h of plan.hashes) {
    const result = await backend.read(h.path);
    if (result.ok) {
      currentContents.set(h.path, result.value.content);
    }
    // Missing files will be caught by validateStaleness
  }

  const issues = validateStaleness(plan.hashes, currentContents);
  if (issues.length > 0) {
    return {
      ok: false,
      error: {
        error: "Files changed since plan creation",
        code: "STALE_REF",
        issues,
      },
    };
  }
  return { ok: true };
}

interface ApplyStepsResult {
  readonly stepResults: readonly StepResult[];
  readonly snapshots: readonly FileSnapshot[];
  readonly failedAtIndex: number;
}

async function applyStepsWithSnapshots(
  backend: FileSystemBackend,
  plan: CodePlan,
): Promise<ApplyStepsResult> {
  const results: StepResult[] = [];
  const snapshots: FileSnapshot[] = [];

  for (const [i, step] of plan.steps.entries()) {
    // Take snapshot before applying
    const snapshot = await takeSnapshot(backend, step, i);

    const result = await applyStep(backend, step, i);
    results.push(result);

    if (!result.success) {
      return { stepResults: results, snapshots, failedAtIndex: i };
    }

    // Only record snapshot for successfully applied steps
    if (snapshot !== undefined) {
      snapshots.push(snapshot);
    }
  }
  return { stepResults: results, snapshots, failedAtIndex: -1 };
}

async function takeSnapshot(
  backend: FileSystemBackend,
  step: CodePlanStep,
  stepIndex: number,
): Promise<FileSnapshot | undefined> {
  if (step.kind === "create") {
    // File shouldn't exist yet — rollback = delete
    return { stepIndex, path: step.path, kind: "created" };
  }

  if (step.kind === "edit") {
    // Read current content for restore on rollback
    const readResult = await backend.read(step.path);
    if (readResult.ok) {
      return {
        stepIndex,
        path: step.path,
        kind: "modified",
        previousContent: readResult.value.content,
      };
    }
    return undefined;
  }

  if (step.kind === "delete") {
    // Delete step — save content so we can recreate on rollback
    const readResult = await backend.read(step.path);
    if (readResult.ok) {
      return {
        stepIndex,
        path: step.path,
        kind: "deleted",
        previousContent: readResult.value.content,
      };
    }
    return undefined;
  }

  // Rename step — record source and destination for reverse rename on rollback
  return { stepIndex, path: step.path, kind: "renamed", renamedTo: step.to };
}

async function rollbackSteps(
  backend: FileSystemBackend,
  snapshots: readonly FileSnapshot[],
): Promise<string[]> {
  const errors: string[] = [];
  // Reverse order (LIFO)
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const snapshot = snapshots[i];
    if (snapshot === undefined) continue;

    try {
      if (snapshot.kind === "created") {
        // Undo create: delete the file
        if (backend.delete !== undefined) {
          const result = await backend.delete(snapshot.path);
          if (!result.ok) {
            errors.push(`Rollback failed for ${snapshot.path}: ${result.error.message}`);
          }
        } else {
          // Write empty content as fallback when delete is unavailable
          errors.push(
            `Cannot rollback create for ${snapshot.path}: backend does not support delete`,
          );
        }
      } else if (snapshot.kind === "modified" && snapshot.previousContent !== undefined) {
        // Undo edit: restore original content
        const result = await backend.write(snapshot.path, snapshot.previousContent);
        if (!result.ok) {
          errors.push(`Rollback failed for ${snapshot.path}: ${result.error.message}`);
        }
      } else if (snapshot.kind === "deleted" && snapshot.previousContent !== undefined) {
        // Undo delete: recreate the file
        const result = await backend.write(snapshot.path, snapshot.previousContent, {
          createDirectories: true,
        });
        if (!result.ok) {
          errors.push(`Rollback failed for ${snapshot.path}: ${result.error.message}`);
        }
      } else if (snapshot.kind === "renamed" && snapshot.renamedTo !== undefined) {
        // Undo rename: rename back from destination to source
        if (backend.rename !== undefined) {
          const result = await backend.rename(snapshot.renamedTo, snapshot.path);
          if (!result.ok) {
            errors.push(`Rollback failed for ${snapshot.path}: ${result.error.message}`);
          }
        } else {
          errors.push(
            `Cannot rollback rename for ${snapshot.path}: backend does not support rename`,
          );
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`Rollback failed for ${snapshot.path}: ${message}`);
    }
  }
  return errors;
}

async function applyStep(
  backend: FileSystemBackend,
  step: CodePlanStep,
  stepIndex: number,
): Promise<StepResult> {
  try {
    if (step.kind === "create") {
      const result = await backend.write(step.path, step.content, { createDirectories: true });
      if (!result.ok) {
        return { stepIndex, path: step.path, success: false, error: result.error.message };
      }
      return { stepIndex, path: step.path, success: true };
    }

    if (step.kind === "delete") {
      if (backend.delete === undefined) {
        return {
          stepIndex,
          path: step.path,
          success: false,
          error: "Backend does not support file deletion",
        };
      }
      const result = await backend.delete(step.path);
      if (!result.ok) {
        return { stepIndex, path: step.path, success: false, error: result.error.message };
      }
      return { stepIndex, path: step.path, success: true };
    }

    if (step.kind === "rename") {
      if (backend.rename === undefined) {
        return {
          stepIndex,
          path: step.path,
          success: false,
          error: "Backend does not support file rename",
        };
      }
      const result = await backend.rename(step.path, step.to);
      if (!result.ok) {
        return { stepIndex, path: step.path, success: false, error: result.error.message };
      }
      return { stepIndex, path: step.path, success: true };
    }

    // Edit step
    const result = await backend.edit(step.path, step.edits);
    if (!result.ok) {
      return { stepIndex, path: step.path, success: false, error: result.error.message };
    }
    return { stepIndex, path: step.path, success: true };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { stepIndex, path: step.path, success: false, error: message };
  }
}
