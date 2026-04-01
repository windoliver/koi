import { describe, expect, test } from "bun:test";
import type { RunReport } from "@koi/core";
import { agentId, runId, sessionId } from "@koi/core/ecs";
import { mapReportToJson, mapReportToMarkdown } from "./formatters.js";

function makeReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    agentId: agentId("agent-1"),
    sessionId: sessionId("session-1"),
    runId: runId("run-1"),
    summary: "Completed 5 actions across 3 turns.",
    duration: {
      startedAt: 1700000000000,
      completedAt: 1700000060000,
      durationMs: 60000,
      totalTurns: 3,
      totalActions: 5,
      truncated: false,
    },
    actions: [
      {
        kind: "model_call",
        name: "gpt-4",
        turnIndex: 0,
        durationMs: 1200,
        success: true,
        tokenUsage: { inputTokens: 500, outputTokens: 200 },
      },
      {
        kind: "tool_call",
        name: "file_write",
        turnIndex: 1,
        durationMs: 50,
        success: true,
      },
    ],
    artifacts: [{ id: "output.json", kind: "file", uri: "file:///workspace/output.json" }],
    issues: [
      {
        severity: "warning",
        message: "Rate limit approaching",
        turnIndex: 2,
        resolved: true,
        resolution: "Backed off",
      },
    ],
    cost: {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      estimatedCostUsd: 0.045,
    },
    recommendations: ["Consider caching repeated queries", "Add retry logic"],
    ...overrides,
  };
}

describe("mapReportToMarkdown", () => {
  test("contains Summary section", () => {
    const md = mapReportToMarkdown(makeReport());
    expect(md).toContain("## Summary");
    expect(md).toContain("Completed 5 actions across 3 turns.");
  });

  test("contains Actions table with correct data", () => {
    const md = mapReportToMarkdown(makeReport());
    expect(md).toContain("## Actions");
    expect(md).toContain("| # | Type | Name | Turn | Duration | Status |");
    expect(md).toContain("| 1 | model_call | gpt-4 | 0 | 1200ms | success |");
    expect(md).toContain("| 2 | tool_call | file_write | 1 | 50ms | success |");
  });

  test("contains Artifacts section", () => {
    const md = mapReportToMarkdown(makeReport());
    expect(md).toContain("## Artifacts");
    expect(md).toContain("| output.json | file | file:///workspace/output.json |");
  });

  test("contains Issues section", () => {
    const md = mapReportToMarkdown(makeReport());
    expect(md).toContain("## Issues");
    expect(md).toContain("| warning | Rate limit approaching | 2 | yes |");
  });

  test("contains Cost section", () => {
    const md = mapReportToMarkdown(makeReport());
    expect(md).toContain("## Cost");
    expect(md).toContain("- Input tokens: 1000");
    expect(md).toContain("- Output tokens: 500");
    expect(md).toContain("- Total tokens: 1500");
    expect(md).toContain("- Estimated cost: $0.0450");
  });

  test("contains Recommendations list", () => {
    const md = mapReportToMarkdown(makeReport());
    expect(md).toContain("## Recommendations");
    expect(md).toContain("- Consider caching repeated queries");
    expect(md).toContain("- Add retry logic");
  });

  test("renders child reports recursively", () => {
    const child: RunReport = makeReport({
      agentId: agentId("child-agent"),
      summary: "Child completed 2 actions.",
    });
    const parent = makeReport({ childReports: [child] });
    const md = mapReportToMarkdown(parent);
    expect(md).toContain("## Child Agent Reports");
    expect(md).toContain("Child completed 2 actions.");
  });

  test("handles empty actions/artifacts/issues", () => {
    const md = mapReportToMarkdown(
      makeReport({ actions: [], artifacts: [], issues: [], recommendations: [] }),
    );
    expect(md).toContain("No actions recorded.");
    expect(md).toContain("No artifacts produced.");
    expect(md).toContain("No issues encountered.");
    expect(md).toContain("No recommendations.");
  });

  test("shows objective when provided", () => {
    const md = mapReportToMarkdown(makeReport({ objective: "Refactor auth module" }));
    expect(md).toContain("Refactor auth module");
  });

  test("indicates truncated action log", () => {
    const md = mapReportToMarkdown(
      makeReport({
        duration: {
          startedAt: 1700000000000,
          completedAt: 1700000060000,
          durationMs: 60000,
          totalTurns: 3,
          totalActions: 600,
          truncated: true,
        },
      }),
    );
    expect(md).toContain("(log truncated)");
  });
});

describe("mapReportToJson", () => {
  test("returns valid JSON matching RunReport shape", () => {
    const report = makeReport();
    const json = mapReportToJson(report);
    const parsed = JSON.parse(json) as RunReport;
    expect(parsed.agentId).toBe(agentId("agent-1"));
    expect(parsed.sessionId).toBe(sessionId("session-1"));
    expect(parsed.summary).toBe("Completed 5 actions across 3 turns.");
    expect(parsed.actions).toHaveLength(2);
    expect(parsed.cost.totalTokens).toBe(1500);
  });
});
