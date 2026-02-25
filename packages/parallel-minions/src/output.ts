/**
 * Output formatting for parallel batch results.
 *
 * Produces structured markdown with per-task sections.
 */

import type { BatchResult, MinionTask } from "./types.js";
import { DEFAULT_MAX_TOTAL_OUTPUT } from "./types.js";

const TRUNCATION_NOTICE = "\n\n... [remaining output truncated due to total size limit]";

/**
 * Formats a BatchResult as structured markdown.
 *
 * Output format:
 * ```
 * ## Batch Results (N/M succeeded, strategy: best-effort)
 *
 * ### Task 1: <description> [SUCCESS]
 * <output>
 *
 * ### Task 2: <description> [FAILED]
 * Error: <error message>
 * ```
 *
 * Truncation: if total output exceeds maxTotalOutput, later tasks
 * are truncated. The summary header is always preserved.
 */
export function formatBatchResult(
  result: BatchResult,
  tasks: readonly MinionTask[],
  maxTotalOutput?: number | undefined,
): string {
  const cap = maxTotalOutput ?? DEFAULT_MAX_TOTAL_OUTPUT;
  const { summary, outcomes } = result;

  const header = `## Batch Results (${summary.succeeded}/${summary.total} succeeded, strategy: ${summary.strategy})`;

  if (outcomes.length === 0) {
    return header;
  }

  const sections: string[] = [header];
  // let justified: mutable running total for truncation tracking
  let totalLength = header.length;

  // Sort outcomes by taskIndex to ensure deterministic ordering
  const sorted = [...outcomes].sort((a, b) => a.taskIndex - b.taskIndex);

  for (const outcome of sorted) {
    const task = tasks[outcome.taskIndex];
    const desc = task?.description ?? "(unknown task)";
    const status = outcome.ok ? "SUCCESS" : "FAILED";
    const body = outcome.ok ? outcome.output : `Error: ${outcome.error}`;
    const section = `\n\n### Task ${outcome.taskIndex + 1}: ${desc} [${status}]\n${body}`;

    if (totalLength + section.length > cap - TRUNCATION_NOTICE.length) {
      sections.push(TRUNCATION_NOTICE);
      break;
    }

    sections.push(section);
    totalLength += section.length;
  }

  return sections.join("");
}
