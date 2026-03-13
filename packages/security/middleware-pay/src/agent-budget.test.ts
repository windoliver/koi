import { describe, expect, test } from "bun:test";
import { createAgentBudgetTracker } from "./agent-budget.js";

const DEFAULT_CONFIG = {
  maxTokensPerAgent: 10_000,
  softThresholdPercent: 0.8,
} as const;

describe("createAgentBudgetTracker", () => {
  describe("computeAllocation", () => {
    test("depth 0 gets full budget", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      expect(tracker.computeAllocation(0)).toBe(10_000);
    });

    test("depth 1 gets half budget", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      expect(tracker.computeAllocation(1)).toBe(5_000);
    });

    test("depth 2 gets quarter budget", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      expect(tracker.computeAllocation(2)).toBe(2_500);
    });

    test("deep depth respects minimum floor of 1024", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      // depth 10: 10000 / 1024 ≈ 9.77, so floor kicks in
      expect(tracker.computeAllocation(10)).toBe(1024);
    });

    test("caps depth at 10 for allocation computation", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      expect(tracker.computeAllocation(10)).toBe(tracker.computeAllocation(15));
    });
  });

  describe("recordUsage", () => {
    test("returns false when under budget", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      const exceeded = tracker.recordUsage("agent-1", 1000, 0);
      expect(exceeded).toBe(false);
    });

    test("returns true when budget is exceeded", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      tracker.recordUsage("agent-1", 9000, 0);
      const exceeded = tracker.recordUsage("agent-1", 2000, 0);
      expect(exceeded).toBe(true);
    });

    test("returns true when exactly at budget", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      const exceeded = tracker.recordUsage("agent-1", 10_000, 0);
      expect(exceeded).toBe(true);
    });

    test("accumulates across multiple calls", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      tracker.recordUsage("agent-1", 3000, 0);
      tracker.recordUsage("agent-1", 3000, 0);
      expect(tracker.checkBudget("agent-1")).toBe("ok");
      tracker.recordUsage("agent-1", 3000, 0);
      expect(tracker.checkBudget("agent-1")).toBe("warn");
    });
  });

  describe("checkBudget", () => {
    test("returns 'ok' for unknown agent", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      expect(tracker.checkBudget("unknown")).toBe("ok");
    });

    test("returns 'ok' when under soft threshold", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      tracker.recordUsage("agent-1", 7999, 0);
      expect(tracker.checkBudget("agent-1")).toBe("ok");
    });

    test("returns 'warn' at exactly 80%", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      tracker.recordUsage("agent-1", 8000, 0);
      expect(tracker.checkBudget("agent-1")).toBe("warn");
    });

    test("returns 'warn' between 80% and 100%", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      tracker.recordUsage("agent-1", 9500, 0);
      expect(tracker.checkBudget("agent-1")).toBe("warn");
    });

    test("returns 'exceeded' at 100%", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      tracker.recordUsage("agent-1", 10_000, 0);
      expect(tracker.checkBudget("agent-1")).toBe("exceeded");
    });

    test("returns 'exceeded' over 100%", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      tracker.recordUsage("agent-1", 11_000, 0);
      expect(tracker.checkBudget("agent-1")).toBe("exceeded");
    });
  });

  describe("getBudgetWarning", () => {
    test("returns undefined for unknown agent", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      expect(tracker.getBudgetWarning("unknown")).toBeUndefined();
    });

    test("returns undefined when under threshold", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      tracker.recordUsage("agent-1", 5000, 0);
      expect(tracker.getBudgetWarning("agent-1")).toBeUndefined();
    });

    test("returns warning message at threshold", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      tracker.recordUsage("agent-1", 8500, 0);
      const warning = tracker.getBudgetWarning("agent-1");
      expect(warning).toBeDefined();
      expect(warning?.senderId).toBe("system:budget-warning");
      expect(warning?.content[0]?.kind).toBe("text");
      if (warning?.content[0]?.kind === "text") {
        expect(warning?.content[0].text).toContain("85%");
        expect(warning?.content[0].text).toContain("wrap up");
      }
    });

    test("returns warning only once (idempotent)", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      tracker.recordUsage("agent-1", 8500, 0);
      const first = tracker.getBudgetWarning("agent-1");
      expect(first).toBeDefined();
      const second = tracker.getBudgetWarning("agent-1");
      expect(second).toBeUndefined();
    });
  });

  describe("cleanup", () => {
    test("removes agent budget state", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      tracker.recordUsage("agent-1", 9000, 0);
      expect(tracker.checkBudget("agent-1")).toBe("warn");

      tracker.cleanup("agent-1");
      expect(tracker.checkBudget("agent-1")).toBe("ok");
    });

    test("cleanup of unknown agent is safe", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      tracker.cleanup("nonexistent"); // should not throw
    });
  });

  describe("per-agent isolation", () => {
    test("different agents have independent budgets", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      tracker.recordUsage("agent-a", 9500, 0);
      tracker.recordUsage("agent-b", 1000, 0);

      expect(tracker.checkBudget("agent-a")).toBe("warn");
      expect(tracker.checkBudget("agent-b")).toBe("ok");
    });

    test("child agent gets smaller budget based on depth", () => {
      const tracker = createAgentBudgetTracker(DEFAULT_CONFIG);
      // Parent: depth 0, budget = 10000
      tracker.recordUsage("parent", 5000, 0);
      // Child: depth 1, budget = 5000
      tracker.recordUsage("child", 4500, 1);

      expect(tracker.checkBudget("parent")).toBe("ok");
      expect(tracker.checkBudget("child")).toBe("warn"); // 4500/5000 = 90%
    });
  });
});
