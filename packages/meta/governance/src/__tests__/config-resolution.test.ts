/**
 * Unit tests for config resolution (3-layer merge).
 *
 * Verifies:
 *   - Empty config resolves to "open" preset defaults
 *   - Explicit preset "strict" resolves strict defaults
 *   - User override wins over preset
 *   - permissionRules shorthand creates pattern backend
 *   - permissions + permissionRules throws
 *   - exec-approvals without onAsk throws
 *   - pay triggers deprecation warning
 *   - Scope merging: user scope overrides preset scope
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolveGovernanceConfig } from "../config-resolution.js";

// Spy on console.warn for pay deprecation tests
const originalWarn = console.warn;
let warnSpy: ReturnType<typeof mock>;

beforeEach(() => {
  warnSpy = mock(() => undefined);
  console.warn = warnSpy;
});

afterEach(() => {
  console.warn = originalWarn;
});

describe("resolveGovernanceConfig", () => {
  // ── Preset resolution ─────────────────────────────────────────────────

  test("empty config resolves open preset → has permissions", () => {
    const resolved = resolveGovernanceConfig({});
    expect(resolved.permissions).toBeDefined();
  });

  test("empty config defaults to open preset", () => {
    const resolved = resolveGovernanceConfig({});
    expect(resolved.preset ?? "open").toBe("open");
  });

  test("explicit preset strict resolves strict defaults", () => {
    const resolved = resolveGovernanceConfig({ preset: "strict" });
    expect(resolved.pii?.strategy).toBe("redact");
    expect(resolved.guardrails).toBeDefined();
    expect(resolved.scope?.filesystem?.mode).toBe("ro");
  });

  test("explicit preset standard resolves standard defaults", () => {
    const resolved = resolveGovernanceConfig({ preset: "standard" });
    expect(resolved.pii?.strategy).toBe("mask");
    expect(resolved.sanitize).toBeDefined();
    expect(resolved.scope?.filesystem?.mode).toBe("rw");
  });

  // ── User overrides ────────────────────────────────────────────────────

  test("user pii override wins over preset", () => {
    const resolved = resolveGovernanceConfig({
      preset: "standard",
      pii: { strategy: "redact" },
    });
    // User specified "redact", standard preset has "mask"
    expect(resolved.pii?.strategy).toBe("redact");
  });

  test("user scope overrides preset scope", () => {
    const resolved = resolveGovernanceConfig({
      preset: "strict",
      scope: { filesystem: { root: "/custom", mode: "rw" } },
    });
    expect(resolved.scope?.filesystem?.root).toBe("/custom");
    expect(resolved.scope?.filesystem?.mode).toBe("rw");
  });

  // ── Permission rules shorthand ────────────────────────────────────────

  test("permissionRules shorthand creates permissions backend", () => {
    const resolved = resolveGovernanceConfig({
      permissionRules: { allow: ["tool:read"], deny: [], ask: [] },
    });
    expect(resolved.permissions).toBeDefined();
    expect(resolved.permissions?.backend).toBeDefined();
  });

  // ── Mutual exclusion ─────────────────────────────────────────────────

  test("permissions + permissionRules throws", () => {
    expect(() =>
      resolveGovernanceConfig({
        permissions: { backend: { check: () => ({ effect: "allow" as const }) } },
        permissionRules: { allow: ["*"], deny: [], ask: [] },
      }),
    ).toThrow(/Cannot provide both/);
  });

  // ── Exec-approvals validation ─────────────────────────────────────────

  test("exec-approvals without onAsk is valid (auto-wired dynamically)", () => {
    const result = resolveGovernanceConfig({
      execApprovals: {
        rules: { allow: ["*"], deny: [], ask: [] },
        // No onAsk — auto-wired during agent assembly via ComponentProvider
      },
    });
    expect(result.execApprovals).toBeDefined();
  });

  // ── Pay (no longer deprecated) ──────────────────────────────────────

  test("pay no longer triggers deprecation warning", () => {
    resolveGovernanceConfig({
      pay: {
        tracker: {
          record: async () => undefined,
          totalSpend: async () => 0,
          remaining: async () => 1000,
          breakdown: async () => ({ totalCostUsd: 0, byModel: [], byTool: [] }),
        },
        calculator: { calculate: () => 0 },
        budget: 1000,
      },
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // ── Pass-through fields ───────────────────────────────────────────

  test("intentCapsule passed through without preset defaults", () => {
    const resolved = resolveGovernanceConfig({
      preset: "strict",
      intentCapsule: { systemPrompt: "My mission." },
    });
    expect(resolved.intentCapsule?.systemPrompt).toBe("My mission.");
  });

  // ── agentMonitor + securityAnalyzer resolution ────────────────────────

  test("agentMonitor: user override wins over preset", () => {
    const resolved = resolveGovernanceConfig({
      preset: "standard",
      agentMonitor: { thresholds: { maxToolCallsPerTurn: 5 } },
    });
    expect(resolved.agentMonitor?.thresholds?.maxToolCallsPerTurn).toBe(5);
  });

  test("securityAnalyzer: preset defaults applied when user omits", () => {
    const resolved = resolveGovernanceConfig({ preset: "strict" });
    expect(resolved.securityAnalyzer).toBeDefined();
    expect(resolved.securityAnalyzer?.elevateOnAnomalyKinds).toContain("tool_rate_exceeded");
  });

  test("agentMonitor: undefined when preset is open and user omits", () => {
    const resolved = resolveGovernanceConfig({});
    expect(resolved.agentMonitor).toBeUndefined();
  });

  test("securityAnalyzer: user override wins over preset", () => {
    const resolved = resolveGovernanceConfig({
      preset: "strict",
      securityAnalyzer: { highPatterns: ["custom-pattern"] },
    });
    expect(resolved.securityAnalyzer?.highPatterns).toEqual(["custom-pattern"]);
  });

  test("agentMonitor: preset standard provides default config", () => {
    const resolved = resolveGovernanceConfig({ preset: "standard" });
    expect(resolved.agentMonitor).toBeDefined();
  });

  test("delegationEscalation passed through without preset defaults", () => {
    const config = {
      channel: { name: "mock", capabilities: {} },
      isExhausted: () => false,
      issuerId: "supervisor",
      monitoredDelegateeIds: [],
    };
    const resolved = resolveGovernanceConfig({
      preset: "strict",
      delegationEscalation: config as never,
    });
    expect(resolved.delegationEscalation).toBeDefined();
  });
});
