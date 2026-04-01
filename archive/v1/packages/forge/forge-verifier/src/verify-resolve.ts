/**
 * Stage 1.5: Resolve — audits and installs npm dependencies for bricks
 * that declare `requires.packages`. Inserted between Static and Sandbox stages.
 *
 * Bricks without `requires.packages` skip with a pass.
 */

import type { Result } from "@koi/core";
import type {
  DependencyConfig,
  ForgeError,
  ForgeInput,
  ResolveStageReport,
} from "@koi/forge-types";
import { auditDependencies } from "./dependency-audit.js";
import { createBrickWorkspace, writeBrickEntry } from "./workspace-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasImplementation(
  input: ForgeInput,
): input is Extract<ForgeInput, { readonly implementation: string }> {
  return "implementation" in input && typeof input.implementation === "string";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function verifyResolve(
  input: ForgeInput,
  config: DependencyConfig,
): Promise<Result<ResolveStageReport, ForgeError>> {
  const start = performance.now();
  const packages = input.requires?.packages;

  // No packages declared — skip with pass
  if (packages === undefined || Object.keys(packages).length === 0) {
    return {
      ok: true,
      value: {
        stage: "resolve",
        passed: true,
        durationMs: performance.now() - start,
        message: "No packages declared — skipped",
      },
    };
  }

  // Fast path: reuse existing workspace (skip audit + install)
  // Used by harness-search to avoid repeated dependency resolution per refinement iteration
  if (config.reuseWorkspace !== undefined) {
    // let justified: entryPath is conditionally assigned based on brick kind
    let entryPath: string | undefined;
    if (hasImplementation(input)) {
      entryPath = await writeBrickEntry(config.reuseWorkspace, input.implementation, input.name);
    }
    return {
      ok: true,
      value: {
        stage: "resolve",
        passed: true,
        durationMs: performance.now() - start,
        workspacePath: config.reuseWorkspace,
        ...(entryPath !== undefined ? { entryPath } : {}),
        message: "Dependencies resolved (workspace reuse)",
      },
    };
  }

  // Step 1: Audit dependencies
  const auditResult = auditDependencies(packages, config);
  if (!auditResult.ok) {
    return { ok: false, error: auditResult.error };
  }

  // Step 2: Create workspace and install
  const workspaceResult = await createBrickWorkspace(packages, config);
  if (!workspaceResult.ok) {
    return { ok: false, error: workspaceResult.error };
  }

  const { workspacePath } = workspaceResult.value;

  // Step 3: Write entry file (only for implementation-bearing bricks)
  // let justified: entryPath is conditionally assigned based on brick kind
  let entryPath: string | undefined;
  if (hasImplementation(input)) {
    entryPath = await writeBrickEntry(workspacePath, input.implementation, input.name);
  }

  const durationMs = performance.now() - start;

  return {
    ok: true,
    value: {
      stage: "resolve",
      passed: true,
      durationMs,
      workspacePath,
      ...(entryPath !== undefined ? { entryPath } : {}),
      message: workspaceResult.value.cached
        ? "Dependencies resolved (cached)"
        : "Dependencies installed",
    },
  };
}
