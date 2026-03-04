/**
 * synthesize tool — aggregate completed task results in dependency order.
 */

import type { TaskItemId } from "@koi/core";
import { topologicalSort } from "./dag.js";
import type { BoardHolder } from "./orchestrate-tool.js";
import { DEFAULT_ORCHESTRATOR_CONFIG } from "./types.js";

interface SynthesizeInput {
  readonly format?: "summary" | "detailed" | "structured" | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseInput(raw: unknown): SynthesizeInput {
  if (!isRecord(raw)) return {};
  const format = raw.format;
  if (format === "summary" || format === "detailed" || format === "structured") {
    return { format };
  }
  return {};
}

/**
 * Executes the synthesize tool.
 */
export function executeSynthesize(
  raw: unknown,
  holder: BoardHolder,
  maxOutputPerTask?: number,
): string {
  const input = parseInput(raw);
  const board = holder.getBoard();
  const results = board.completed();

  if (results.length === 0) {
    return "No completed tasks to synthesize.";
  }

  const maxOutput = maxOutputPerTask ?? DEFAULT_ORCHESTRATOR_CONFIG.maxOutputPerTask;

  // Build a map for quick lookup
  const resultMap = new Map<TaskItemId, string>();
  for (const r of results) {
    resultMap.set(r.taskId, r.output);
  }

  // Get items map for topological sort
  const items = new Map<
    TaskItemId,
    typeof board extends { readonly get: (id: TaskItemId) => infer R } ? NonNullable<R> : never
  >();
  for (const item of board.all()) {
    items.set(item.id, item);
  }

  // Order results by topological sort
  const sorted = topologicalSort(items);
  const orderedIds = sorted.filter((id) => resultMap.has(id));

  // Build full result map for structured field rendering
  const fullResultMap = new Map(results.map((r) => [r.taskId, r] as const));

  const sections: string[] = [];
  for (const id of orderedIds) {
    const item = board.get(id);
    const taskResult = fullResultMap.get(id);
    const output = resultMap.get(id) ?? "";
    const truncated =
      output.length > maxOutput ? `${output.slice(0, maxOutput)}... (truncated)` : output;

    const header = item !== undefined ? `## ${id}: ${item.description}` : `## ${id}`;
    const parts: string[] = [`${header}\n${truncated}`];

    if (taskResult?.artifacts !== undefined && taskResult.artifacts.length > 0) {
      const artLines = taskResult.artifacts.map((a) => `- ${a.kind}: ${a.uri}`);
      parts.push(`\n### Artifacts\n${artLines.join("\n")}`);
    }

    if (taskResult?.warnings !== undefined && taskResult.warnings.length > 0) {
      parts.push(`\n### Warnings\n${taskResult.warnings.map((w) => `- ${w}`).join("\n")}`);
    }

    if (taskResult?.decisions !== undefined && taskResult.decisions.length > 0) {
      const decLines = taskResult.decisions.map(
        (d) => `- [${d.agentId}] ${d.action}: ${d.reasoning}`,
      );
      parts.push(`\n### Decisions\n${decLines.join("\n")}`);
    }

    sections.push(parts.join(""));
  }

  const formatLabel = input.format ?? "summary";
  return `# Synthesis (${formatLabel}) — ${results.length} task(s)\n\n${sections.join("\n\n")}`;
}
