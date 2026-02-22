import { describe, expect, test } from "bun:test";
import { validateConfig } from "./config.js";
import { createAutoApprovalHandler, createPatternPermissionEngine } from "./engine.js";

describe("validateConfig", () => {
  const engine = createPatternPermissionEngine();
  const rules = { allow: ["*"], deny: [], ask: [] } as const;

  test("accepts valid config with required fields", () => {
    const result = validateConfig({ engine, rules });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.engine).toBe(engine);
      expect(result.value.rules).toBe(rules);
    }
  });

  test("rejects null config", () => {
    const result = validateConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects undefined config", () => {
    const result = validateConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects config without engine", () => {
    const result = validateConfig({ rules });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("engine");
    }
  });

  test("rejects config without rules", () => {
    const result = validateConfig({ engine });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("rules");
    }
  });

  test("rejects rules missing allow array", () => {
    const result = validateConfig({ engine, rules: { deny: [], ask: [] } });
    expect(result.ok).toBe(false);
  });

  test("rejects rules missing deny array", () => {
    const result = validateConfig({ engine, rules: { allow: [], ask: [] } });
    expect(result.ok).toBe(false);
  });

  test("rejects rules missing ask array", () => {
    const result = validateConfig({ engine, rules: { allow: [], deny: [] } });
    expect(result.ok).toBe(false);
  });

  test("requires approvalHandler when ask rules exist", () => {
    const rulesWithAsk = { allow: [], deny: [], ask: ["dangerous:*"] } as const;
    const result = validateConfig({ engine, rules: rulesWithAsk });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("approvalHandler");
    }
  });

  test("accepts ask rules with approvalHandler", () => {
    const rulesWithAsk = { allow: [], deny: [], ask: ["dangerous:*"] } as const;
    const handler = createAutoApprovalHandler();
    const result = validateConfig({ engine, rules: rulesWithAsk, approvalHandler: handler });
    expect(result.ok).toBe(true);
  });

  test("rejects negative approvalTimeoutMs", () => {
    const result = validateConfig({ engine, rules, approvalTimeoutMs: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("approvalTimeoutMs");
    }
  });

  test("rejects zero approvalTimeoutMs", () => {
    const result = validateConfig({ engine, rules, approvalTimeoutMs: 0 });
    expect(result.ok).toBe(false);
  });

  test("accepts positive approvalTimeoutMs", () => {
    const result = validateConfig({ engine, rules, approvalTimeoutMs: 5000 });
    expect(result.ok).toBe(true);
  });

  test("applies default values for optional fields", () => {
    const result = validateConfig({ engine, rules });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.approvalHandler).toBeUndefined();
      expect(result.value.approvalTimeoutMs).toBeUndefined();
      expect(result.value.defaultDeny).toBeUndefined();
    }
  });

  test("all errors are non-retryable", () => {
    const result = validateConfig(null);
    if (!result.ok) {
      expect(result.error.retryable).toBe(false);
    }
  });
});
