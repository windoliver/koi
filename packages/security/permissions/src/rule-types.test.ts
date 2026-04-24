import { describe, expect, test } from "bun:test";
import type { PermissionRule } from "./rule-types.js";
import { SOURCE_PRECEDENCE } from "./rule-types.js";

describe("PermissionRule.on_deny (#1650)", () => {
  test("rule accepts optional on_deny: 'hard'", () => {
    const r: PermissionRule = {
      pattern: "/etc/**",
      action: "write",
      effect: "deny",
      on_deny: "hard",
    };
    expect(r.on_deny).toBe("hard");
  });

  test("rule accepts optional on_deny: 'soft'", () => {
    const r: PermissionRule = {
      pattern: "/tmp/**",
      action: "write",
      effect: "deny",
      on_deny: "soft",
    };
    expect(r.on_deny).toBe("soft");
  });

  test("rule without on_deny still compiles (backward compat)", () => {
    const r: PermissionRule = {
      pattern: "/etc/**",
      action: "write",
      effect: "deny",
    };
    expect(r.on_deny).toBeUndefined();
  });
});

describe("SOURCE_PRECEDENCE", () => {
  test("includes flag as 2nd highest priority (after policy)", () => {
    expect(SOURCE_PRECEDENCE[0]).toBe("policy");
    expect(SOURCE_PRECEDENCE[1]).toBe("flag");
  });

  test("has exactly 5 tiers", () => {
    expect(SOURCE_PRECEDENCE).toHaveLength(5);
  });

  test("flag has higher priority than local", () => {
    const flagIdx = SOURCE_PRECEDENCE.indexOf("flag");
    const localIdx = SOURCE_PRECEDENCE.indexOf("local");
    expect(flagIdx).toBeLessThan(localIdx);
  });
});
