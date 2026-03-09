/**
 * TDD tests for brick-kind selector (Issue #917 Phase 2).
 *
 * Tests written FIRST per TDD methodology. Each trigger kind maps to a
 * specific brick kind or is suppressed.
 */

import { describe, expect, test } from "bun:test";
import type { BrickId, ForgeTrigger } from "@koi/core";
import { selectBrickKind } from "./brick-kind-selector.js";

describe("selectBrickKind", () => {
  // -------------------------------------------------------------------------
  // Tool-level failure triggers → skill
  // -------------------------------------------------------------------------

  test("repeated_failure → skill", () => {
    const trigger: ForgeTrigger = { kind: "repeated_failure", toolName: "my_tool", count: 3 };
    const result = selectBrickKind(trigger);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.kind).toBe("skill");
    }
  });

  test("capability_gap → skill", () => {
    const trigger: ForgeTrigger = {
      kind: "capability_gap",
      requiredCapability: "file management",
    };
    const result = selectBrickKind(trigger);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.kind).toBe("skill");
    }
  });

  test("no_matching_tool → skill", () => {
    const trigger: ForgeTrigger = { kind: "no_matching_tool", query: "csv_parser", attempts: 1 };
    const result = selectBrickKind(trigger);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.kind).toBe("skill");
    }
  });

  // -------------------------------------------------------------------------
  // Agent-level triggers → agent
  // -------------------------------------------------------------------------

  test("agent_capability_gap → agent", () => {
    const trigger: ForgeTrigger = { kind: "agent_capability_gap", agentType: "researcher" };
    const result = selectBrickKind(trigger);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.kind).toBe("agent");
    }
  });

  test("agent_repeated_failure → agent", () => {
    const trigger: ForgeTrigger = {
      kind: "agent_repeated_failure",
      agentType: "researcher",
      brickId: "brick-1" as BrickId,
      errorRate: 0.8,
    };
    const result = selectBrickKind(trigger);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.kind).toBe("agent");
    }
  });

  // -------------------------------------------------------------------------
  // Performance degradation → suppressed (optimize, don't forge)
  // -------------------------------------------------------------------------

  test("performance_degradation → tool (optimization brick)", () => {
    const trigger: ForgeTrigger = {
      kind: "performance_degradation",
      toolName: "slow_tool",
      metric: "avgLatencyMs=8000",
    };
    const result = selectBrickKind(trigger);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.kind).toBe("tool");
    }
  });

  test("agent_latency_degradation → suppressed", () => {
    const trigger: ForgeTrigger = {
      kind: "agent_latency_degradation",
      agentType: "worker",
      brickId: "brick-2" as BrickId,
      p95Ms: 10000,
    };
    const result = selectBrickKind(trigger);
    expect(result.suppressed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Success-side triggers → skill
  // -------------------------------------------------------------------------

  test("complex_task_completed → skill", () => {
    const trigger: ForgeTrigger = {
      kind: "complex_task_completed",
      taskDescription: "refactored auth module",
      toolsUsed: ["read_file", "write_file", "run_tests"],
      turnCount: 8,
    };
    const result = selectBrickKind(trigger);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.kind).toBe("skill");
    }
  });

  test("user_correction → skill", () => {
    const trigger: ForgeTrigger = {
      kind: "user_correction",
      correctionDescription: "use snake_case not camelCase",
    };
    const result = selectBrickKind(trigger);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.kind).toBe("skill");
    }
  });

  test("novel_workflow → skill", () => {
    const trigger: ForgeTrigger = {
      kind: "novel_workflow",
      workflowDescription: "deploy via blue-green strategy",
      toolSequence: ["build", "deploy_staging", "smoke_test", "swap_live"],
    };
    const result = selectBrickKind(trigger);
    expect(result.suppressed).toBe(false);
    if (!result.suppressed) {
      expect(result.kind).toBe("skill");
    }
  });

  // -------------------------------------------------------------------------
  // Exhaustiveness: every trigger kind is covered
  // -------------------------------------------------------------------------

  test("all 10 trigger kinds return a valid result", () => {
    const triggers: readonly ForgeTrigger[] = [
      { kind: "repeated_failure", toolName: "t", count: 1 },
      { kind: "no_matching_tool", query: "q", attempts: 1 },
      { kind: "capability_gap", requiredCapability: "c" },
      { kind: "performance_degradation", toolName: "t", metric: "m" },
      { kind: "agent_capability_gap", agentType: "a" },
      {
        kind: "agent_repeated_failure",
        agentType: "a",
        brickId: "b" as BrickId,
        errorRate: 0.5,
      },
      { kind: "agent_latency_degradation", agentType: "a", brickId: "b" as BrickId, p95Ms: 100 },
      {
        kind: "complex_task_completed",
        taskDescription: "t",
        toolsUsed: [],
        turnCount: 1,
      },
      { kind: "user_correction", correctionDescription: "c" },
      { kind: "novel_workflow", workflowDescription: "w", toolSequence: [] },
    ];

    for (const trigger of triggers) {
      const result = selectBrickKind(trigger);
      expect(typeof result.suppressed).toBe("boolean");
      if (!result.suppressed) {
        expect(["tool", "skill", "agent", "middleware", "channel", "composite"]).toContain(
          result.kind,
        );
      }
    }
  });
});
