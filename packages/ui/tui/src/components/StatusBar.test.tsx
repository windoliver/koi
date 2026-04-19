import { testRender } from "@opentui/solid";
import { describe, expect, test } from "bun:test";
import type { GovernanceSnapshot } from "@koi/core/governance";
import { createInitialState } from "../state/initial.js";
import { createStore } from "../state/store.js";
import { StoreContext } from "../store-context.js";
import { StatusBar } from "./StatusBar.js";
import {
  chipTier,
  formatCost,
  formatGovernanceChip,
  formatTokens,
  mostStressedSensor,
} from "./status-bar-helpers.js";

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
  test("small numbers render as-is", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
  });

  test("thousands render with 'k' suffix", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(999_999)).toBe("1000.0k");
  });

  test("millions render with 'M' suffix", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

// ---------------------------------------------------------------------------
// formatCost
// ---------------------------------------------------------------------------

describe("formatCost", () => {
  test("null (no cost data) renders as em-dash", () => {
    expect(formatCost(null)).toBe("—");
  });

  test("costs under $0.01 render to 4 decimal places", () => {
    expect(formatCost(0.0001)).toBe("$0.0001");
    expect(formatCost(0.005)).toBe("$0.0050");
    expect(formatCost(0.009_9)).toBe("$0.0099");
  });

  test("costs >= $0.01 render to 2 decimal places", () => {
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(0.05)).toBe("$0.05");
    expect(formatCost(1.23)).toBe("$1.23");
    expect(formatCost(100)).toBe("$100.00");
  });

  test("zero cost renders as 4 decimal places (under threshold)", () => {
    expect(formatCost(0)).toBe("$0.0000");
  });
});

// ---------------------------------------------------------------------------
// gov-9: governance chip helpers
// ---------------------------------------------------------------------------

describe("mostStressedSensor", () => {
  test("returns null when snapshot is null", () => {
    expect(mostStressedSensor(null)).toBeNull();
  });

  test("returns null when readings empty", () => {
    const snap: GovernanceSnapshot = {
      timestamp: 0,
      healthy: true,
      violations: [],
      readings: [],
    };
    expect(mostStressedSensor(snap)).toBeNull();
  });

  test("picks reading with highest utilization", () => {
    const snap: GovernanceSnapshot = {
      timestamp: 0,
      healthy: true,
      violations: [],
      readings: [
        { name: "turn_count", current: 5, limit: 10, utilization: 0.5 },
        { name: "cost_usd", current: 1.6, limit: 2.0, utilization: 0.8 },
        { name: "spawn_count", current: 1, limit: 5, utilization: 0.2 },
      ],
    };
    expect(mostStressedSensor(snap)?.name).toBe("cost_usd");
  });
});

describe("formatGovernanceChip", () => {
  test("turn_count uses N/N format", () => {
    expect(
      formatGovernanceChip({ name: "turn_count", current: 12, limit: 50, utilization: 0.24 }),
    ).toBe("turn 12/50");
  });

  test("spawn_count uses spawn N/N", () => {
    expect(
      formatGovernanceChip({ name: "spawn_count", current: 4, limit: 5, utilization: 0.8 }),
    ).toBe("spawn 4/5");
  });

  test("spawn_depth uses depth N/N", () => {
    expect(
      formatGovernanceChip({ name: "spawn_depth", current: 2, limit: 4, utilization: 0.5 }),
    ).toBe("depth 2/4");
  });

  test("cost_usd uses $X.XX/$X.XX format", () => {
    expect(
      formatGovernanceChip({ name: "cost_usd", current: 1.4, limit: 2.0, utilization: 0.7 }),
    ).toBe("cost $1.40/$2.00");
  });

  test("token_usage uses k suffix when >= 1000", () => {
    expect(
      formatGovernanceChip({ name: "token_usage", current: 12500, limit: 100000, utilization: 0.125 }),
    ).toBe("tokens 12.5k/100.0k");
  });

  test("generic variable uses utilization %", () => {
    expect(
      formatGovernanceChip({ name: "error_rate", current: 0.3, limit: 0.5, utilization: 0.6 }),
    ).toBe("error_rate 60%");
  });
});

describe("chipTier", () => {
  test("returns 'ok' below 0.5", () => {
    expect(chipTier(0.0)).toBe("ok");
    expect(chipTier(0.49)).toBe("ok");
  });

  test("returns 'warn' between 0.5 and 0.8", () => {
    expect(chipTier(0.5)).toBe("warn");
    expect(chipTier(0.79)).toBe("warn");
  });

  test("returns 'danger' at or above 0.8", () => {
    expect(chipTier(0.8)).toBe("danger");
    expect(chipTier(1.0)).toBe("danger");
  });
});

// ---------------------------------------------------------------------------
// StatusBar governance chip rendering
// ---------------------------------------------------------------------------

describe("StatusBar governance chip rendering", () => {
  test("hides chip when no governance snapshot", async () => {
    const store = createStore(createInitialState());
    const utils = await testRender(
      () => (
        <StoreContext.Provider value={store}>
          <StatusBar width={120} />
        </StoreContext.Provider>
      ),
      { width: 120, height: 1 },
    );
    await utils.renderOnce();
    expect(utils.captureCharFrame()).not.toContain("gov:");
    utils.renderer.destroy();
  });

  test("renders gov chip when snapshot present", async () => {
    const store = createStore(createInitialState());
    store.dispatch({
      kind: "set_governance_snapshot",
      snapshot: {
        timestamp: 0,
        healthy: true,
        violations: [],
        readings: [{ name: "turn_count", current: 12, limit: 50, utilization: 0.24 }],
      },
    });
    const utils = await testRender(
      () => (
        <StoreContext.Provider value={store}>
          <StatusBar width={120} />
        </StoreContext.Provider>
      ),
      { width: 120, height: 1 },
    );
    await utils.renderOnce();
    expect(utils.captureCharFrame()).toContain("gov: turn 12/50");
    utils.renderer.destroy();
  });
});
