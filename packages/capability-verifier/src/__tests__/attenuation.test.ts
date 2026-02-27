/**
 * Attenuation property tests.
 *
 * Tests the isAttenuated() predicate with systematic case coverage.
 * No external property-testing library — uses parameterized manual cases
 * that cover the key monotonicity invariants:
 *
 * - Child allow ⊆ parent allow (subset rule)
 * - Parent wildcard "*" allows any child allow list
 * - Child deny ⊇ parent deny (deny only grows)
 * - Identity: same permissions → attenuated (equal is valid)
 * - Empty child allow is always attenuated
 * - Extra permissions in child → NOT attenuated
 */

import { describe, expect, test } from "bun:test";
import type { PermissionConfig } from "@koi/core";
import { isAttenuated } from "../attenuation.js";

// Helper to reduce boilerplate
function child(allow: string[], deny?: string[]): PermissionConfig {
  return deny !== undefined ? { allow, deny } : { allow };
}
function parent(allow: string[], deny?: string[]): PermissionConfig {
  return deny !== undefined ? { allow, deny } : { allow };
}

describe("isAttenuated", () => {
  // ─────────────────────────────────────────────
  // Basic subset / superset cases
  // ─────────────────────────────────────────────

  test("same permissions → attenuated (identity)", () => {
    expect(isAttenuated(child(["read", "write"]), parent(["read", "write"]))).toBe(true);
  });

  test("child is strict subset → attenuated", () => {
    expect(isAttenuated(child(["read"]), parent(["read", "write"]))).toBe(true);
  });

  test("child has extra permission not in parent → NOT attenuated", () => {
    expect(isAttenuated(child(["read", "execute"]), parent(["read", "write"]))).toBe(false);
  });

  test("child is empty allow → attenuated (empty set ⊆ anything)", () => {
    expect(isAttenuated(child([]), parent(["read", "write"]))).toBe(true);
  });

  test("both empty allow → attenuated", () => {
    expect(isAttenuated(child([]), parent([]))).toBe(true);
  });

  test("child has single permission not in empty parent → NOT attenuated", () => {
    expect(isAttenuated(child(["read"]), parent([]))).toBe(false);
  });

  // ─────────────────────────────────────────────
  // Wildcard parent
  // ─────────────────────────────────────────────

  test("parent wildcard '*' allows any child allow list", () => {
    expect(isAttenuated(child(["read", "write", "execute", "delete"]), parent(["*"]))).toBe(true);
  });

  test("parent wildcard '*' allows empty child", () => {
    expect(isAttenuated(child([]), parent(["*"]))).toBe(true);
  });

  test("parent wildcard '*' allows wildcard child", () => {
    expect(isAttenuated(child(["*"]), parent(["*"]))).toBe(true);
  });

  test("child wildcard '*' without parent wildcard → NOT attenuated", () => {
    // Child claims all permissions but parent only allows specific ones
    expect(isAttenuated(child(["*"]), parent(["read", "write"]))).toBe(false);
  });

  // ─────────────────────────────────────────────
  // Deny list inheritance — deny only grows
  // ─────────────────────────────────────────────

  test("child preserves parent deny list → attenuated", () => {
    expect(isAttenuated(child(["read"], ["execute"]), parent(["read", "write"], ["execute"]))).toBe(
      true,
    );
  });

  test("child drops a parent deny entry → NOT attenuated", () => {
    // Parent denies "execute", child omits it from deny → child could escalate
    expect(isAttenuated(child(["read"], []), parent(["read", "write"], ["execute"]))).toBe(false);
  });

  test("child adds extra deny → attenuated (more restrictive is fine)", () => {
    expect(isAttenuated(child(["read", "write"], ["write"]), parent(["read", "write"], []))).toBe(
      true,
    );
  });

  test("child deny = parent deny (identity) → attenuated", () => {
    expect(
      isAttenuated(child(["read", "write"], ["execute"]), parent(["read", "write"], ["execute"])),
    ).toBe(true);
  });

  test("parent has no deny, child has deny → attenuated (adding deny is OK)", () => {
    expect(isAttenuated(child(["read"], ["read"]), parent(["read", "write"]))).toBe(true);
  });

  // ─────────────────────────────────────────────
  // Combination cases
  // ─────────────────────────────────────────────

  test("subset allow + superset deny → attenuated", () => {
    expect(
      isAttenuated(child(["read"], ["write", "execute"]), parent(["read", "write"], ["write"])),
    ).toBe(true);
  });

  test("superset allow + superset deny → NOT attenuated (allow fails first)", () => {
    expect(
      isAttenuated(
        child(["read", "write", "execute"], ["execute"]),
        parent(["read", "write"], ["execute"]),
      ),
    ).toBe(false);
  });

  test("subset allow + missing required deny → NOT attenuated (deny fails)", () => {
    expect(isAttenuated(child(["read"], []), parent(["read", "write"], ["admin"]))).toBe(false);
  });

  // ─────────────────────────────────────────────
  // Parameterized property: subset check is monotonic
  // (Any subset of a valid child is also attenuated)
  // ─────────────────────────────────────────────

  const PERMISSIONS = ["read", "write", "execute", "delete", "admin"] as const;

  test("all single-permission subsets of a 3-perm parent are attenuated", () => {
    const parentPerms = ["read", "write", "execute"];
    for (const perm of parentPerms) {
      expect(isAttenuated(child([perm]), parent(parentPerms))).toBe(true);
    }
  });

  test("permissions not in parent are never attenuated regardless of others", () => {
    const parentPerms = ["read", "write"];
    const outsidePerms = PERMISSIONS.filter((p) => !parentPerms.includes(p));
    for (const perm of outsidePerms) {
      // Even if paired with valid perms, adding an outside perm should fail
      expect(isAttenuated(child(["read", perm]), parent(parentPerms))).toBe(false);
    }
  });

  // ─────────────────────────────────────────────
  // Edge cases
  // ─────────────────────────────────────────────

  test("undefined allow treated as empty array", () => {
    const noAllow: PermissionConfig = {};
    expect(isAttenuated(noAllow, parent(["read"]))).toBe(true);
  });

  test("both with undefined allow and deny → attenuated", () => {
    const p: PermissionConfig = {};
    const c: PermissionConfig = {};
    expect(isAttenuated(c, p)).toBe(true);
  });
});
