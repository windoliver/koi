/**
 * Unit tests for governance deployment presets.
 *
 * Verifies:
 *   - All 3 presets are defined and frozen
 *   - "open" has permissionRules.allow: ["*"]
 *   - "standard" has pii, sanitize, scope with filesystem + browser
 *   - "strict" has pii.strategy: "redact", guardrails, scope with all 4 subsystems
 *   - Ordering invariant: open field count <= standard <= strict
 */

import { describe, expect, test } from "bun:test";
import { GOVERNANCE_PRESET_SPECS } from "../presets.js";

describe("GOVERNANCE_PRESET_SPECS", () => {
  test("all 3 presets are defined", () => {
    expect(GOVERNANCE_PRESET_SPECS).toHaveProperty("open");
    expect(GOVERNANCE_PRESET_SPECS).toHaveProperty("standard");
    expect(GOVERNANCE_PRESET_SPECS).toHaveProperty("strict");
  });

  test("registry is frozen", () => {
    expect(Object.isFrozen(GOVERNANCE_PRESET_SPECS)).toBe(true);
  });

  test("each preset spec is frozen", () => {
    expect(Object.isFrozen(GOVERNANCE_PRESET_SPECS.open)).toBe(true);
    expect(Object.isFrozen(GOVERNANCE_PRESET_SPECS.standard)).toBe(true);
    expect(Object.isFrozen(GOVERNANCE_PRESET_SPECS.strict)).toBe(true);
  });

  // ── Open preset ───────────────────────────────────────────────────────

  test("open: permissionRules allows everything", () => {
    const open = GOVERNANCE_PRESET_SPECS.open;
    expect(open.permissionRules).toBeDefined();
    expect(open.permissionRules?.allow).toEqual(["*"]);
    expect(open.permissionRules?.deny).toEqual([]);
    expect(open.permissionRules?.ask).toEqual([]);
  });

  test("open: no middleware beyond permissions", () => {
    const open = GOVERNANCE_PRESET_SPECS.open;
    expect(open.pii).toBeUndefined();
    expect(open.sanitize).toBeUndefined();
    expect(open.guardrails).toBeUndefined();
    expect(open.scope).toBeUndefined();
  });

  // ── Standard preset ───────────────────────────────────────────────────

  test("standard: has pii with mask strategy", () => {
    expect(GOVERNANCE_PRESET_SPECS.standard.pii?.strategy).toBe("mask");
  });

  test("standard: has sanitize with empty rules", () => {
    expect(GOVERNANCE_PRESET_SPECS.standard.sanitize).toBeDefined();
    expect(GOVERNANCE_PRESET_SPECS.standard.sanitize?.rules).toEqual([]);
  });

  test("standard: scope has filesystem (rw) and browser", () => {
    const scope = GOVERNANCE_PRESET_SPECS.standard.scope;
    expect(scope?.filesystem?.root).toBe(".");
    expect(scope?.filesystem?.mode).toBe("rw");
    expect(scope?.browser?.blockPrivateAddresses).toBe(true);
  });

  test("standard: no guardrails", () => {
    expect(GOVERNANCE_PRESET_SPECS.standard.guardrails).toBeUndefined();
  });

  // ── Strict preset ────────────────────────────────────────────────────

  test("strict: pii uses redact strategy", () => {
    expect(GOVERNANCE_PRESET_SPECS.strict.pii?.strategy).toBe("redact");
  });

  test("strict: has guardrails", () => {
    expect(GOVERNANCE_PRESET_SPECS.strict.guardrails).toBeDefined();
  });

  test("strict: scope has all 4 subsystems", () => {
    const scope = GOVERNANCE_PRESET_SPECS.strict.scope;
    expect(scope?.filesystem).toBeDefined();
    expect(scope?.browser).toBeDefined();
    expect(scope?.credentials).toBeDefined();
    expect(scope?.memory).toBeDefined();
  });

  test("strict: filesystem is read-only", () => {
    expect(GOVERNANCE_PRESET_SPECS.strict.scope?.filesystem?.mode).toBe("ro");
  });

  test("strict: browser allows only https", () => {
    expect(GOVERNANCE_PRESET_SPECS.strict.scope?.browser?.allowedProtocols).toEqual(["https:"]);
  });

  // ── Ordering invariant ────────────────────────────────────────────────

  test("preset field count: open <= standard <= strict", () => {
    const openKeys = Object.keys(GOVERNANCE_PRESET_SPECS.open).length;
    const stdKeys = Object.keys(GOVERNANCE_PRESET_SPECS.standard).length;
    const strictKeys = Object.keys(GOVERNANCE_PRESET_SPECS.strict).length;
    expect(stdKeys).toBeGreaterThanOrEqual(openKeys);
    expect(strictKeys).toBeGreaterThanOrEqual(stdKeys);
  });
});
