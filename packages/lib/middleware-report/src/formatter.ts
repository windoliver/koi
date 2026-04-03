/**
 * Report formatter — converts RunReport to markdown.
 */

import type { RunReport } from "@koi/core";

export function mapReportToMarkdown(report: RunReport): string {
  const lines: string[] = ["# Run Report", ""];

  // Summary
  lines.push("## Summary", report.summary, "");

  // Objective
  if (report.objective) {
    lines.push("## Objective", report.objective, "");
  }

  // Duration
  lines.push(
    "## Duration",
    `- Started: ${new Date(report.duration.startedAt).toISOString()}`,
    `- Completed: ${new Date(report.duration.completedAt).toISOString()}`,
    `- Duration: ${String(report.duration.durationMs)}ms`,
    `- Turns: ${String(report.duration.totalTurns)}`,
    `- Actions: ${String(report.duration.totalActions)}${report.duration.truncated ? " (truncated)" : ""}`,
    "",
  );

  // Actions table
  if (report.actions.length > 0) {
    lines.push(
      "## Actions",
      "| # | Type | Name | Turn | Duration | Status |",
      "|---|------|------|------|----------|--------|",
    );
    for (const [i, a] of report.actions.entries()) {
      const status = a.success ? "success" : `error: ${a.errorMessage ?? "unknown"}`;
      lines.push(
        `| ${String(i + 1)} | ${a.kind} | ${a.name} | ${String(a.turnIndex)} | ${String(a.durationMs)}ms | ${status} |`,
      );
    }
    lines.push("");
  }

  // Issues table
  if (report.issues.length > 0) {
    lines.push(
      "## Issues",
      "| Severity | Message | Turn | Resolved |",
      "|----------|---------|------|----------|",
    );
    for (const issue of report.issues) {
      lines.push(
        `| ${issue.severity} | ${issue.message} | ${String(issue.turnIndex)} | ${issue.resolved ? "yes" : "no"} |`,
      );
    }
    lines.push("");
  }

  // Cost
  lines.push(
    "## Cost",
    `- Input tokens: ${String(report.cost.inputTokens)}`,
    `- Output tokens: ${String(report.cost.outputTokens)}`,
    `- Total tokens: ${String(report.cost.totalTokens)}`,
  );
  if (report.cost.estimatedCostUsd !== undefined) {
    lines.push(`- Estimated cost: $${report.cost.estimatedCostUsd.toFixed(4)}`);
  }
  lines.push("");

  // Recommendations
  if (report.recommendations.length > 0) {
    lines.push("## Recommendations");
    for (const rec of report.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
