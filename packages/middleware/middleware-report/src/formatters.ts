/**
 * Output formatters for RunReport — Markdown and JSON.
 */

import type { RunReport } from "@koi/core";

function formatTimestamp(epoch: number): string {
  return new Date(epoch).toISOString();
}

function formatDurationSection(report: RunReport): string {
  const { duration } = report;
  const actionsSuffix = duration.truncated ? " (log truncated)" : "";
  const lines: readonly string[] = [
    "## Duration",
    "",
    `- Started: ${formatTimestamp(duration.startedAt)}`,
    `- Completed: ${formatTimestamp(duration.completedAt)}`,
    `- Duration: ${duration.durationMs}ms`,
    `- Turns: ${duration.totalTurns}`,
    `- Actions: ${duration.totalActions}${actionsSuffix}`,
  ];
  return lines.join("\n");
}

function formatActionsSection(report: RunReport): string {
  if (report.actions.length === 0) {
    return "## Actions\n\nNo actions recorded.";
  }

  const header = [
    "## Actions",
    "",
    "| # | Type | Name | Turn | Duration | Status |",
    "|---|------|------|------|----------|--------|",
  ];

  const rows = report.actions.map((a, i) => {
    const status = a.success ? "success" : `error: ${a.errorMessage ?? "unknown"}`;
    return `| ${i + 1} | ${a.kind} | ${a.name} | ${a.turnIndex} | ${a.durationMs}ms | ${status} |`;
  });

  return [...header, ...rows].join("\n");
}

function formatArtifactsSection(report: RunReport): string {
  if (report.artifacts.length === 0) {
    return "## Artifacts\n\nNo artifacts produced.";
  }

  const header = ["## Artifacts", "", "| Name | Kind | URI |", "|------|------|-----|"];

  const rows = report.artifacts.map((a) => `| ${a.id} | ${a.kind} | ${a.uri} |`);

  return [...header, ...rows].join("\n");
}

function formatIssuesSection(report: RunReport): string {
  if (report.issues.length === 0) {
    return "## Issues\n\nNo issues encountered.";
  }

  const header = [
    "## Issues",
    "",
    "| Severity | Message | Turn | Resolved |",
    "|----------|---------|------|----------|",
  ];

  const rows = report.issues.map(
    (i) => `| ${i.severity} | ${i.message} | ${i.turnIndex} | ${i.resolved ? "yes" : "no"} |`,
  );

  return [...header, ...rows].join("\n");
}

function formatCostSection(report: RunReport): string {
  const { cost } = report;
  const lines: readonly string[] = [
    "## Cost",
    "",
    `- Input tokens: ${cost.inputTokens}`,
    `- Output tokens: ${cost.outputTokens}`,
    `- Total tokens: ${cost.totalTokens}`,
    ...(cost.estimatedCostUsd !== undefined
      ? [`- Estimated cost: $${cost.estimatedCostUsd.toFixed(4)}`]
      : []),
  ];
  return lines.join("\n");
}

function formatRecommendationsSection(report: RunReport): string {
  if (report.recommendations.length === 0) {
    return "## Recommendations\n\nNo recommendations.";
  }

  const items = report.recommendations.map((r) => `- ${r}`);
  return ["## Recommendations", "", ...items].join("\n");
}

function formatChildReports(report: RunReport, depth: number): string {
  if (!report.childReports || report.childReports.length === 0) {
    return "";
  }

  const sections = report.childReports.map((child) => formatReportInternal(child, depth + 1));

  return `## Child Agent Reports\n\n${sections.join("\n\n---\n\n")}`;
}

function formatReportInternal(report: RunReport, depth: number): string {
  const prefix = "#".repeat(Math.min(depth, 4));
  const sections: readonly string[] = [
    `${prefix} Run Report`,
    "",
    `${prefix}# Summary`,
    "",
    report.summary,
    "",
    ...(report.objective !== undefined ? [`${prefix}# Objective`, "", report.objective, ""] : []),
    formatDurationSection(report),
    "",
    formatActionsSection(report),
    "",
    formatArtifactsSection(report),
    "",
    formatIssuesSection(report),
    "",
    formatCostSection(report),
    "",
    formatRecommendationsSection(report),
    ...(report.childReports && report.childReports.length > 0
      ? ["", formatChildReports(report, depth)]
      : []),
  ];

  return sections.join("\n");
}

/** Format a RunReport as a Markdown document. */
export function mapReportToMarkdown(report: RunReport): string {
  return formatReportInternal(report, 1);
}

/** Format a RunReport as pretty-printed JSON. */
export function mapReportToJson(report: RunReport): string {
  return JSON.stringify(report, null, 2);
}
