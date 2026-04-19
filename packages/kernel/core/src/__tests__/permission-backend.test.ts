import { describe, expect, test } from "bun:test";
import type { PermissionDecision } from "../permission-backend.js";

describe("PermissionDecision.disposition (L0, #1650)", () => {
  test("deny decision accepts optional disposition: 'hard'", () => {
    const d: PermissionDecision = { effect: "deny", reason: "nope", disposition: "hard" };
    expect(d.effect).toBe("deny");
    if (d.effect === "deny") expect(d.disposition).toBe("hard");
  });

  test("deny decision accepts optional disposition: 'soft'", () => {
    const d: PermissionDecision = { effect: "deny", reason: "nope", disposition: "soft" };
    if (d.effect === "deny") expect(d.disposition).toBe("soft");
  });

  test("deny decision without disposition still compiles (backward compat)", () => {
    const d: PermissionDecision = { effect: "deny", reason: "nope" };
    if (d.effect === "deny") expect(d.disposition).toBeUndefined();
  });

  test("allow and ask variants do not accept disposition (type-level)", () => {
    const a: PermissionDecision = { effect: "allow" };
    const k: PermissionDecision = { effect: "ask", reason: "confirm?" };
    expect(a.effect).toBe("allow");
    expect(k.effect).toBe("ask");
  });
});
