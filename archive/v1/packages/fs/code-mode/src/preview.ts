/**
 * Preview generation for code plans.
 *
 * Produces truncated, diff-style output for human review.
 */

import { PREVIEW_CONTEXT_LINES, PREVIEW_LINES_PER_FILE, PREVIEW_LINES_TOTAL } from "./constants.js";
import type { CodePlan, CodePlanStep, FilePreview, PlanPreview } from "./types.js";

/**
 * Generate a preview of a code plan suitable for display to an agent or user.
 */
export function generatePreview(plan: CodePlan): PlanPreview {
  const creates = plan.steps.filter((s) => s.kind === "create").length;
  const edits = plan.steps.filter((s) => s.kind === "edit").length;
  const deletes = plan.steps.filter((s) => s.kind === "delete").length;
  const renames = plan.steps.filter((s) => s.kind === "rename").length;

  const parts: string[] = [];
  if (creates > 0) parts.push(`${creates} create${creates > 1 ? "s" : ""}`);
  if (edits > 0) parts.push(`${edits} edit${edits > 1 ? "s" : ""}`);
  if (deletes > 0) parts.push(`${deletes} delete${deletes > 1 ? "s" : ""}`);
  if (renames > 0) parts.push(`${renames} rename${renames > 1 ? "s" : ""}`);
  const summary = `${plan.steps.length} file${plan.steps.length !== 1 ? "s" : ""}: ${parts.join(", ")}`;

  /* let justified: mutable counter for total line budget */
  let totalLinesUsed = 0;
  let totalLinesTruncated = false;
  const files: FilePreview[] = [];

  for (const step of plan.steps) {
    const budgetRemaining = PREVIEW_LINES_TOTAL - totalLinesUsed;
    if (budgetRemaining <= 0) {
      totalLinesTruncated = true;
      break;
    }

    const preview = generateFilePreview(
      step,
      Math.min(PREVIEW_LINES_PER_FILE, budgetRemaining),
      plan.fileContents,
    );
    files.push(preview);
    totalLinesUsed += preview.lines.length;

    if (preview.truncated) {
      totalLinesTruncated = true;
    }
  }

  return {
    planId: plan.id,
    summary,
    files,
    totalLinesTruncated,
    warnings: plan.warnings,
  };
}

// ─── Internal ────────────────────────────────────────────────────────────

function generateFilePreview(
  step: CodePlanStep,
  maxLines: number,
  fileContents?: ReadonlyMap<string, string>,
): FilePreview {
  if (step.kind === "create") {
    return generateCreatePreview(step, maxLines);
  }
  if (step.kind === "delete") {
    return generateDeletePreview(step);
  }
  if (step.kind === "rename") {
    return generateRenamePreview(step);
  }
  return generateEditPreview(step, maxLines, fileContents);
}

function generateCreatePreview(
  step: {
    readonly kind: "create";
    readonly path: string;
    readonly content: string;
    readonly description?: string;
  },
  maxLines: number,
): FilePreview {
  const contentLines = step.content.split("\n");
  const header =
    step.description !== undefined ? `+++ ${step.path} (${step.description})` : `+++ ${step.path}`;

  const lines: string[] = [header];
  const truncated = contentLines.length > maxLines - 1;
  const displayCount = Math.min(contentLines.length, maxLines - 1);

  for (let i = 0; i < displayCount; i++) {
    lines.push(`+ ${contentLines[i]}`);
  }
  if (truncated) {
    lines.push(`... ${contentLines.length - displayCount} more lines`);
  }

  return { path: step.path, kind: "create", lines, truncated };
}

function generateDeletePreview(step: {
  readonly kind: "delete";
  readonly path: string;
  readonly description?: string;
}): FilePreview {
  const header =
    step.description !== undefined ? `--- ${step.path} (${step.description})` : `--- ${step.path}`;

  return {
    path: step.path,
    kind: "delete",
    lines: [header, "(file will be deleted)"],
    truncated: false,
  };
}

function generateRenamePreview(step: {
  readonly kind: "rename";
  readonly path: string;
  readonly to: string;
  readonly description?: string;
}): FilePreview {
  const header =
    step.description !== undefined
      ? `>>> ${step.path} -> ${step.to} (${step.description})`
      : `>>> ${step.path} -> ${step.to}`;

  return {
    path: step.path,
    kind: "rename",
    lines: [header],
    truncated: false,
  };
}

function generateEditPreview(
  step: {
    readonly kind: "edit";
    readonly path: string;
    readonly edits: readonly { readonly oldText: string; readonly newText: string }[];
    readonly description?: string;
  },
  maxLines: number,
  fileContents?: ReadonlyMap<string, string>,
): FilePreview {
  const header =
    step.description !== undefined ? `~~~ ${step.path} (${step.description})` : `~~~ ${step.path}`;

  const lines: string[] = [header];
  /* let justified: mutable counter tracking line budget */
  let linesUsed = 1;
  let truncated = false;

  const fileContent = fileContents?.get(step.path);
  const fileLines = fileContent !== undefined ? fileContent.split("\n") : undefined;

  for (const edit of step.edits) {
    if (linesUsed >= maxLines) {
      truncated = true;
      break;
    }

    const oldLines = edit.oldText.split("\n");
    const newLines = edit.newText.split("\n");

    // Add context lines before the edit
    if (fileContent !== undefined && fileLines !== undefined) {
      const contextBefore = extractContextBefore(fileContent, edit.oldText, fileLines);
      for (const ctxLine of contextBefore) {
        if (linesUsed >= maxLines) {
          truncated = true;
          break;
        }
        lines.push(`  ${ctxLine}`);
        linesUsed++;
      }
    }

    for (const line of oldLines) {
      if (linesUsed >= maxLines) {
        truncated = true;
        break;
      }
      lines.push(`- ${line}`);
      linesUsed++;
    }
    for (const line of newLines) {
      if (linesUsed >= maxLines) {
        truncated = true;
        break;
      }
      lines.push(`+ ${line}`);
      linesUsed++;
    }

    // Add context lines after the edit
    if (fileContent !== undefined && fileLines !== undefined && !truncated) {
      const contextAfter = extractContextAfter(fileContent, edit.oldText, fileLines);
      for (const ctxLine of contextAfter) {
        if (linesUsed >= maxLines) {
          truncated = true;
          break;
        }
        lines.push(`  ${ctxLine}`);
        linesUsed++;
      }
    }
  }

  if (truncated) {
    lines.push("... (truncated)");
  }

  return { path: step.path, kind: "edit", lines, truncated };
}

/**
 * Extract up to PREVIEW_CONTEXT_LINES lines before the match position.
 */
function extractContextBefore(
  content: string,
  oldText: string,
  fileLines: readonly string[],
): readonly string[] {
  const matchIndex = content.indexOf(oldText);
  if (matchIndex === -1) return [];

  // Count newlines before match to find the starting line
  const textBefore = content.slice(0, matchIndex);
  const matchLineIndex = textBefore.split("\n").length - 1;

  const startLine = Math.max(0, matchLineIndex - PREVIEW_CONTEXT_LINES);
  const result: string[] = [];
  for (let i = startLine; i < matchLineIndex; i++) {
    const line = fileLines[i];
    if (line !== undefined) {
      result.push(line);
    }
  }
  return result;
}

/**
 * Extract up to PREVIEW_CONTEXT_LINES lines after the match end position.
 */
function extractContextAfter(
  content: string,
  oldText: string,
  fileLines: readonly string[],
): readonly string[] {
  const matchIndex = content.indexOf(oldText);
  if (matchIndex === -1) return [];

  // Count newlines up to match end to find the ending line
  const textUpToEnd = content.slice(0, matchIndex + oldText.length);
  const endLineIndex = textUpToEnd.split("\n").length - 1;

  const lastLine = Math.min(fileLines.length - 1, endLineIndex + PREVIEW_CONTEXT_LINES);
  const result: string[] = [];
  for (let i = endLineIndex + 1; i <= lastLine; i++) {
    const line = fileLines[i];
    if (line !== undefined) {
      result.push(line);
    }
  }
  return result;
}
