import { describe, expect, test } from "bun:test";
import { validateGovernanceConfig } from "@koi/governance-core";
import { DEFAULT_PRICING } from "../default-pricing.js";
import { withGovernanceDefaults } from "../with-defaults.js";

describe("withGovernanceDefaults", () => {
  test("zero args produces a config that passes validateGovernanceConfig", () => {
    const config = withGovernanceDefaults();
    const result = validateGovernanceConfig(config);
    expect(result.ok).toBe(true);
  });

  test("exposes the default in-memory controller with all ten variables", () => {
    const { controller } = withGovernanceDefaults();
    expect(controller.variables().size).toBe(10);
  });

  test("pricing overrides flow into the cost calculator", () => {
    const { cost } = withGovernanceDefaults({
      pricing: { ...DEFAULT_PRICING, "custom-model": { inputUsdPer1M: 7, outputUsdPer1M: 11 } },
    });
    expect(cost.calculate("custom-model", 1_000_000, 0)).toBeCloseTo(7, 10);
  });

  test("controllerConfig limits propagate to the controller", () => {
    const { controller } = withGovernanceDefaults({
      controllerConfig: { costUsdLimit: 1.5, turnCountLimit: 7 },
    });
    expect(controller.variables().get("cost_usd")?.limit).toBe(1.5);
    expect(controller.variables().get("turn_count")?.limit).toBe(7);
  });

  test("rules propagate to the pattern backend", async () => {
    const { backend } = withGovernanceDefaults({
      rules: [{ match: { toolId: "Bash" }, decision: "deny", rule: "no-shell" }],
    });
    const { agentId: toAgentId } = await import("@koi/core");
    const result = await backend.evaluator.evaluate({
      kind: "tool_call",
      agentId: toAgentId("a"),
      payload: { toolId: "Bash" },
      timestamp: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]?.rule).toBe("no-shell");
  });

  test("defaultDeny propagates to the pattern backend", async () => {
    const { backend } = withGovernanceDefaults({ defaultDeny: true });
    const { agentId: toAgentId } = await import("@koi/core");
    const result = await backend.evaluator.evaluate({
      kind: "tool_call",
      agentId: toAgentId("a"),
      payload: { toolId: "whatever" },
      timestamp: 0,
    });
    expect(result.ok).toBe(false);
  });

  test("caller-supplied controller / backend / cost short-circuit defaults", () => {
    const controller = { tag: "mock-controller" } as const;
    const backend = { evaluator: { evaluate: () => ({ ok: true as const }) } };
    const cost = { calculate: () => 42 };
    const config = withGovernanceDefaults({
      controller: controller as never,
      backend,
      cost,
    });
    expect(config.controller).toBe(controller as never);
    expect(config.backend).toBe(backend);
    expect(config.cost).toBe(cost);
  });

  test("alertThresholds and callbacks are threaded through", () => {
    const onAlert = (): void => undefined;
    const onViolation = (): void => undefined;
    const onUsage = (): void => undefined;
    const config = withGovernanceDefaults({
      alertThresholds: [0.5, 0.9],
      onAlert,
      onViolation,
      onUsage,
    });
    expect(config.alertThresholds).toEqual([0.5, 0.9]);
    expect(config.onAlert).toBe(onAlert);
    expect(config.onViolation).toBe(onViolation);
    expect(config.onUsage).toBe(onUsage);
  });
});
