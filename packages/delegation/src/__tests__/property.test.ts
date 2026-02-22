/**
 * Property-based tests for delegation invariants.
 *
 * These tests use pseudo-random generation to exercise the core properties:
 * 1. Monotonic attenuation — no child scope exceeds parent scope
 * 2. Signature integrity — any mutation invalidates the signature
 * 3. Expiry monotonicity — child expiresAt <= parent expiresAt
 */

import { describe, expect, test } from "bun:test";
import type { DelegationScope, PermissionConfig } from "@koi/core";
import { attenuateGrant, createGrant } from "../grant.js";
import { verifySignature } from "../sign.js";

const SECRET = "property-test-secret-key-32-bytes";

// ---------------------------------------------------------------------------
// Helpers: pseudo-random scope generation
// ---------------------------------------------------------------------------

const ALL_TOOLS = [
  "read_file",
  "write_file",
  "execute_command",
  "search",
  "list_files",
  "create_dir",
  "delete_file",
  "fetch_url",
] as const;

function randomSubset(items: readonly string[], seed: number): readonly string[] {
  const result: string[] = [];
  for (let i = 0; i < items.length; i++) {
    // Simple LCG-based selection
    const item = items[i];
    if (item !== undefined && (seed * (i + 1) * 7919) % 100 < 50) {
      result.push(item);
    }
  }
  return result;
}

function makeRandomScope(seed: number): DelegationScope {
  const allow = randomSubset(ALL_TOOLS, seed);
  const budget = ((seed * 31) % 200) + 1;
  return {
    permissions: { allow },
    maxBudget: budget,
  };
}

function makeNarrowerScope(parent: DelegationScope, seed: number): DelegationScope {
  const parentAllow = parent.permissions.allow ?? [];
  const childAllow = randomSubset(parentAllow, seed);
  const permissions: PermissionConfig =
    parent.permissions.deny !== undefined
      ? { allow: childAllow, deny: parent.permissions.deny }
      : { allow: childAllow };
  if (parent.maxBudget !== undefined) {
    const childBudget = Math.max(
      1,
      Math.floor((parent.maxBudget * (((seed * 17) % 80) + 10)) / 100),
    );
    return { permissions, maxBudget: childBudget };
  }
  return { permissions };
}

// ---------------------------------------------------------------------------
// Property 1: Monotonic attenuation
// ---------------------------------------------------------------------------

describe("property: monotonic attenuation", () => {
  test("for any valid chain, no child scope exceeds parent scope (50 iterations)", () => {
    for (let seed = 0; seed < 50; seed++) {
      const parentScope = makeRandomScope(seed);
      const parent = createGrant({
        issuerId: "agent-root",
        delegateeId: "agent-1",
        scope: parentScope,
        maxChainDepth: 5,
        ttlMs: 3600000,
        secret: SECRET,
      });

      const childScope = makeNarrowerScope(parentScope, seed + 100);
      const childResult = attenuateGrant(
        parent,
        { delegateeId: "agent-2", scope: childScope },
        SECRET,
      );

      if (childResult.ok) {
        const childGrant = childResult.value;
        const childAllow = new Set(childGrant.scope.permissions.allow ?? []);
        const parentAllow = new Set(parentScope.permissions.allow ?? []);

        // Every child allow must be in parent allow
        for (const perm of childAllow) {
          expect(parentAllow.has(perm)).toBe(true);
        }

        // Child budget <= parent budget
        if (parentScope.maxBudget !== undefined && childGrant.scope.maxBudget !== undefined) {
          expect(childGrant.scope.maxBudget).toBeLessThanOrEqual(parentScope.maxBudget);
        }
      }
      // If attenuation failed, the invariant holds trivially (denied escalation)
    }
  });
});

// ---------------------------------------------------------------------------
// Property 2: Signature integrity
// ---------------------------------------------------------------------------

describe("property: signature integrity", () => {
  const MUTATION_FIELDS = [
    "issuerId",
    "delegateeId",
    "chainDepth",
    "maxChainDepth",
    "createdAt",
    "expiresAt",
  ] as const;

  test("any single-field mutation invalidates the signature (30 iterations)", () => {
    for (let seed = 0; seed < 30; seed++) {
      const grant = createGrant({
        issuerId: `agent-${String(seed)}`,
        delegateeId: `agent-${String(seed + 100)}`,
        scope: makeRandomScope(seed),
        maxChainDepth: 3,
        ttlMs: 3600000,
        secret: SECRET,
      });

      // Original signature is valid
      expect(verifySignature(grant, SECRET)).toBe(true);

      // Mutate each field and verify signature is invalid
      for (const field of MUTATION_FIELDS) {
        const mutated = {
          ...grant,
          [field]:
            typeof grant[field] === "number"
              ? (grant[field] as number) + 1
              : `mutated-${String(grant[field])}`,
        };
        expect(verifySignature(mutated, SECRET)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Property 3: Expiry monotonicity
// ---------------------------------------------------------------------------

describe("property: expiry monotonicity", () => {
  test("for any valid chain, child expiresAt <= parent expiresAt (50 iterations)", () => {
    for (let seed = 0; seed < 50; seed++) {
      const parentScope = makeRandomScope(seed);
      const parent = createGrant({
        issuerId: "agent-root",
        delegateeId: "agent-1",
        scope: parentScope,
        maxChainDepth: 5,
        ttlMs: 3600000,
        secret: SECRET,
      });

      const childScope = makeNarrowerScope(parentScope, seed + 200);
      // Use a TTL that's randomly smaller than parent
      const childTtl = Math.floor((3600000 * (((seed * 13) % 80) + 5)) / 100);
      const childResult = attenuateGrant(
        parent,
        { delegateeId: "agent-2", scope: childScope, ttlMs: childTtl },
        SECRET,
      );

      if (childResult.ok) {
        expect(childResult.value.expiresAt).toBeLessThanOrEqual(parent.expiresAt);

        // Chain further if possible
        const grandchildScope = makeNarrowerScope(childScope, seed + 300);
        const grandchildTtl = Math.floor((childTtl * (((seed * 11) % 80) + 5)) / 100);
        const grandchildResult = attenuateGrant(
          childResult.value,
          { delegateeId: "agent-3", scope: grandchildScope, ttlMs: grandchildTtl },
          SECRET,
        );

        if (grandchildResult.ok) {
          expect(grandchildResult.value.expiresAt).toBeLessThanOrEqual(childResult.value.expiresAt);
          expect(grandchildResult.value.expiresAt).toBeLessThanOrEqual(parent.expiresAt);
        }
      }
    }
  });
});
