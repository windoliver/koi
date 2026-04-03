import { describe, expect, it } from "bun:test";
import type { RunReport } from "@koi/core";
import { agentId, runId, sessionId } from "@koi/core";

import { mapReportToMarkdown } from "./formatter.js";

function makeReport(overrides?: Partial<RunReport>): RunReport {
  return {
    agentId: agentId("test"),
    sessionId: sessionId("s1"),
    runId: runId("r1"),
    summary: "Completed 2 actions across 1 turns in 1000ms.",
    duration: {
      startedAt: 1000,
      completedAt: 2000,
      durationMs: 1000,
      totalTurns: 1,
      totalActions: 2,
      truncated: false,
    },
    actions: [
      { kind: "model_call", name: "test-model", turnIndex: 0, durationMs: 500, success: true },
      { kind: "tool_call", name: "file_read", turnIndex: 0, durationMs: 10, success: true },
    ],
    artifacts: [],
    issues: [],
    cost: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    recommendations: [],
    ...overrides,
  };
}

describe("mapReportToMarkdown", () => {
  it("includes summary section", () => {
    const md = mapReportToMarkdown(makeReport());
    expect(md).toContain("# Run Report");
    expect(md).toContain("## Summary");
    expect(md).toContain("Completed 2 actions");
  });

  it("includes duration section", () => {
    const md = mapReportToMarkdown(makeReport());
    expect(md).toContain("## Duration");
    expect(md).toContain("1000ms");
    expect(md).toContain("Turns: 1");
  });

  it("includes actions table", () => {
    const md = mapReportToMarkdown(makeReport());
    expect(md).toContain("## Actions");
    expect(md).toContain("model_call");
    expect(md).toContain("file_read");
  });

  it("includes objective when present", () => {
    const md = mapReportToMarkdown(makeReport({ objective: "Refactor auth" }));
    expect(md).toContain("## Objective");
    expect(md).toContain("Refactor auth");
  });

  it("omits objective section when absent", () => {
    const md = mapReportToMarkdown(makeReport());
    expect(md).not.toContain("## Objective");
  });

  it("includes issues table when present", () => {
    const md = mapReportToMarkdown(
      makeReport({
        issues: [{ severity: "warning", message: "Tool failed", turnIndex: 0, resolved: false }],
      }),
    );
    expect(md).toContain("## Issues");
    expect(md).toContain("warning");
    expect(md).toContain("Tool failed");
  });

  it("includes cost section", () => {
    const md = mapReportToMarkdown(makeReport());
    expect(md).toContain("## Cost");
    expect(md).toContain("Input tokens: 100");
    expect(md).toContain("Output tokens: 50");
  });

  it("includes estimated cost when present", () => {
    const md = mapReportToMarkdown(
      makeReport({
        cost: { inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCostUsd: 0.0089 },
      }),
    );
    expect(md).toContain("$0.0089");
  });

  it("shows truncated flag", () => {
    const md = mapReportToMarkdown(
      makeReport({
        duration: {
          startedAt: 1000,
          completedAt: 2000,
          durationMs: 1000,
          totalTurns: 1,
          totalActions: 500,
          truncated: true,
        },
      }),
    );
    expect(md).toContain("(truncated)");
  });
});
