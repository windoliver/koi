import { describe, expect, test } from "bun:test";
import * as api from "../index.js";

describe("API surface: @koi/governance-security", () => {
  test("exports expected identifiers", () => {
    const keys = Object.keys(api).sort();
    expect(keys).toMatchSnapshot();
  });

  test("factory functions are callable", () => {
    expect(typeof api.createRulesAnalyzer).toBe("function");
    expect(typeof api.createCompositeAnalyzer).toBe("function");
    expect(typeof api.maxRiskLevel).toBe("function");
    expect(typeof api.createEmailDetector).toBe("function");
    expect(typeof api.createSsnDetector).toBe("function");
    expect(typeof api.createApiKeyDetector).toBe("function");
    expect(typeof api.createPiiDetector).toBe("function");
    expect(typeof api.createAnomalyMonitor).toBe("function");
    expect(typeof api.createSecurityScorer).toBe("function");
  });

  test("BUILTIN_RULES is a non-empty readonly array", () => {
    expect(Array.isArray(api.BUILTIN_RULES)).toBe(true);
    expect(api.BUILTIN_RULES.length).toBeGreaterThan(0);
  });
});
