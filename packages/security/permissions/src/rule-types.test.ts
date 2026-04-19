import { describe, expect, test } from "bun:test";
import type { PermissionRule } from "./rule-types.js";

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
