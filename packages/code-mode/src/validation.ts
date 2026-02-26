/**
 * Validation pipeline for code plans.
 *
 * Checks: file existence, match uniqueness, edit overlaps, file size, staleness.
 */

import { fnv1a } from "@koi/hash";
import { FILE_SIZE_REJECT_BYTES, FILE_SIZE_WARN_BYTES } from "./constants.js";
import type { CodePlanStep, EditStep, FileContentHash, ValidationIssue } from "./types.js";

// ─── Edit position for overlap detection ─────────────────────────────────

interface EditPosition {
  readonly editIndex: number;
  readonly start: number;
  readonly end: number;
}

// ─── Config ──────────────────────────────────────────────────────────────

export interface ValidationConfig {
  readonly fileSizeWarnBytes: number;
  readonly fileSizeRejectBytes: number;
}

export const DEFAULT_VALIDATION_CONFIG: ValidationConfig = {
  fileSizeWarnBytes: FILE_SIZE_WARN_BYTES,
  fileSizeRejectBytes: FILE_SIZE_REJECT_BYTES,
} as const;

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Validate plan steps against file contents. Returns issues found (empty = valid).
 */
export function validateSteps(
  steps: readonly CodePlanStep[],
  fileContents: ReadonlyMap<string, string>,
  config: ValidationConfig = DEFAULT_VALIDATION_CONFIG,
): readonly ValidationIssue[] {
  if (steps.length === 0) {
    return [{ kind: "NO_MATCH", path: "", message: "Plan has no steps", stepIndex: -1 }];
  }
  const issues: ValidationIssue[] = [];
  for (const [i, step] of steps.entries()) {
    if (step.kind === "create") {
      validateCreateStep(step, fileContents, i, issues);
    } else if (step.kind === "delete") {
      validateDeleteStep(step, fileContents, i, issues);
    } else if (step.kind === "rename") {
      validateRenameStep(step, fileContents, i, issues);
    } else {
      validateEditStep(step, fileContents, i, issues, config);
    }
  }
  return issues;
}

/**
 * Compute FNV-1a hashes for file contents referenced by the plan.
 */
export function computeHashes(
  steps: readonly CodePlanStep[],
  fileContents: ReadonlyMap<string, string>,
): readonly FileContentHash[] {
  const seen = new Set<string>();
  const hashes: FileContentHash[] = [];
  for (const step of steps) {
    if (
      (step.kind === "edit" || step.kind === "delete" || step.kind === "rename") &&
      !seen.has(step.path)
    ) {
      seen.add(step.path);
      const content = fileContents.get(step.path);
      if (content !== undefined) {
        hashes.push({ path: step.path, hash: fnv1a(content) });
      }
    }
  }
  return hashes;
}

/**
 * Check staleness by comparing current file hashes against stored hashes.
 */
export function validateStaleness(
  storedHashes: readonly FileContentHash[],
  currentContents: ReadonlyMap<string, string>,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const stored of storedHashes) {
    const current = currentContents.get(stored.path);
    if (current === undefined) {
      issues.push({
        kind: "FILE_NOT_FOUND",
        path: stored.path,
        message: `File was deleted after plan creation: ${stored.path}`,
        stepIndex: -1,
      });
      continue;
    }
    const currentHash = fnv1a(current);
    if (currentHash !== stored.hash) {
      issues.push({
        kind: "STALE",
        path: stored.path,
        message: `File changed since plan creation: ${stored.path}`,
        stepIndex: -1,
      });
    }
  }
  return issues;
}

// ─── Internal validators ─────────────────────────────────────────────────

function validateDeleteStep(
  step: { readonly kind: "delete"; readonly path: string },
  fileContents: ReadonlyMap<string, string>,
  stepIndex: number,
  issues: ValidationIssue[],
): void {
  if (!fileContents.has(step.path)) {
    issues.push({
      kind: "FILE_NOT_FOUND",
      path: step.path,
      message: `File not found: ${step.path}`,
      stepIndex,
    });
  }
}

function validateRenameStep(
  step: { readonly kind: "rename"; readonly path: string; readonly to: string },
  fileContents: ReadonlyMap<string, string>,
  stepIndex: number,
  issues: ValidationIssue[],
): void {
  if (!fileContents.has(step.path)) {
    issues.push({
      kind: "FILE_NOT_FOUND",
      path: step.path,
      message: `Source file not found: ${step.path}`,
      stepIndex,
    });
  }
  if (fileContents.has(step.to)) {
    issues.push({
      kind: "DEST_EXISTS",
      path: step.to,
      message: `Destination already exists: ${step.to}`,
      stepIndex,
    });
  }
}

function validateCreateStep(
  step: { readonly kind: "create"; readonly path: string },
  fileContents: ReadonlyMap<string, string>,
  stepIndex: number,
  issues: ValidationIssue[],
): void {
  if (fileContents.has(step.path)) {
    issues.push({
      kind: "FILE_EXISTS",
      path: step.path,
      message: `File already exists: ${step.path}`,
      stepIndex,
    });
  }
}

function validateEditStep(
  step: EditStep,
  fileContents: ReadonlyMap<string, string>,
  stepIndex: number,
  issues: ValidationIssue[],
  config: ValidationConfig,
): void {
  const content = fileContents.get(step.path);

  if (content === undefined) {
    issues.push({
      kind: "FILE_NOT_FOUND",
      path: step.path,
      message: `File not found: ${step.path}`,
      stepIndex,
    });
    return;
  }

  // Size checks
  const sizeBytes = new TextEncoder().encode(content).byteLength;
  if (sizeBytes > config.fileSizeRejectBytes) {
    issues.push({
      kind: "FILE_TOO_LARGE",
      path: step.path,
      message: `File exceeds size limit (${formatBytes(sizeBytes)} > ${formatBytes(config.fileSizeRejectBytes)}): ${step.path}`,
      stepIndex,
    });
    return;
  }
  if (sizeBytes > config.fileSizeWarnBytes) {
    issues.push({
      kind: "FILE_SIZE_WARNING",
      path: step.path,
      message: `File is large (${formatBytes(sizeBytes)}): ${step.path}`,
      stepIndex,
    });
  }

  // Match checks per edit
  const positions: EditPosition[] = [];
  for (const [j, edit] of step.edits.entries()) {
    const matchResult = validateMatch(content, edit.oldText, step.path, stepIndex, j);
    if (matchResult.issue !== undefined) {
      issues.push(matchResult.issue);
    }
    if (matchResult.position !== undefined) {
      positions.push(matchResult.position);
    }
  }

  // Overlap detection: sort by start, linear scan
  if (positions.length > 1) {
    const sorted = [...positions].sort((a, b) => a.start - b.start);
    for (let k = 1; k < sorted.length; k++) {
      const prev = sorted[k - 1];
      const curr = sorted[k];
      if (prev === undefined || curr === undefined) continue;
      if (curr.start < prev.end) {
        issues.push({
          kind: "OVERLAP",
          path: step.path,
          message: `Edits ${prev.editIndex} and ${curr.editIndex} overlap in ${step.path}`,
          stepIndex,
        });
      }
    }
  }
}

function validateMatch(
  content: string,
  oldText: string,
  path: string,
  stepIndex: number,
  editIndex: number,
): { readonly issue?: ValidationIssue; readonly position?: EditPosition } {
  const firstIndex = content.indexOf(oldText);

  if (firstIndex === -1) {
    return {
      issue: {
        kind: "NO_MATCH",
        path,
        message: `Edit ${editIndex}: oldText not found in ${path}`,
        stepIndex,
      },
    };
  }

  const secondIndex = content.indexOf(oldText, firstIndex + 1);
  if (secondIndex !== -1) {
    return {
      issue: {
        kind: "AMBIGUOUS_MATCH",
        path,
        message: `Edit ${editIndex}: oldText matches multiple locations in ${path}`,
        stepIndex,
      },
    };
  }

  return {
    position: {
      editIndex,
      start: firstIndex,
      end: firstIndex + oldText.length,
    },
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
