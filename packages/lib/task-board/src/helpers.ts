/**
 * Board helpers — snapshot conversion and upstream context formatting.
 */

import type {
  TaskBoard,
  TaskBoardConfig,
  TaskBoardSnapshot,
  TaskItem,
  TaskItemId,
  TaskResult,
} from "@koi/core";
import { createTaskBoard } from "./board.js";

/** Convert a TaskBoard's items to a Map for topologicalSort input. */
export function snapshotToItemsMap(board: TaskBoard): ReadonlyMap<TaskItemId, TaskItem> {
  return new Map(board.all().map((item) => [item.id, item]));
}

/**
 * Formats upstream task results into a context block for downstream workers.
 *
 * Each upstream result is rendered as a structured section. Output text is
 * truncated to `maxCharsPerResult` to prevent context blow-up.
 */
export function formatUpstreamContext(
  results: readonly TaskResult[],
  maxCharsPerResult: number,
): string {
  if (results.length === 0) return "";

  const sections: string[] = [];
  for (const r of results) {
    const lines: string[] = [`[Upstream: ${r.taskId}]`];

    const output =
      r.output.length > maxCharsPerResult
        ? `${r.output.slice(0, maxCharsPerResult)}... (truncated)`
        : r.output;
    lines.push(`Output: ${output}`);

    if (r.artifacts !== undefined && r.artifacts.length > 0) {
      const artList = r.artifacts.map((a) => `${a.kind}:${a.uri}`).join(", ");
      lines.push(`Artifacts: ${artList}`);
    }

    if (r.warnings !== undefined && r.warnings.length > 0) {
      lines.push(`Warnings: ${r.warnings.join("; ")}`);
    }

    sections.push(lines.join("\n"));
  }

  return `--- Upstream Context ---\n${sections.join("\n\n")}\n--- End Upstream Context ---`;
}

/**
 * Extracts a serializable snapshot from a TaskBoard.
 */
export function serializeBoard(board: TaskBoard): TaskBoardSnapshot {
  return {
    items: board.all(),
    results: board.completed(),
  };
}

/**
 * Recreates a TaskBoard from a snapshot.
 */
export function deserializeBoard(snapshot: TaskBoardSnapshot, config?: TaskBoardConfig): TaskBoard {
  return createTaskBoard(config, snapshot);
}
