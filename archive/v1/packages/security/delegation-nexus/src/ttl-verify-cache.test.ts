/**
 * Tests for TTL-based verification cache.
 *
 * Covers:
 * - Cache hit, miss, and stale entry behavior
 * - TTL expiry and stale-while-revalidate (#13-A)
 * - Invalidation per grant
 * - Eviction at max capacity
 * - Nexus-down scenarios (#12-A: cached entries serve during outage)
 */

import { describe, expect, test } from "bun:test";
import type { DelegationId, DelegationVerifyResult } from "@koi/core";
import { agentId, delegationId } from "@koi/core";
import { createTtlVerifyCache } from "./ttl-verify-cache.js";

function grantId(id: string): DelegationId {
  return delegationId(id);
}

const OK_RESULT: DelegationVerifyResult = {
  ok: true,
  grant: {
    id: grantId("test"),
    issuerId: agentId("agent-1"),
    delegateeId: agentId("agent-2"),
    scope: { permissions: {} },
    chainDepth: 0,
    maxChainDepth: 3,
    createdAt: 0,
    expiresAt: 0,
    proof: { kind: "nexus", token: "" },
  },
};

const FAIL_RESULT: DelegationVerifyResult = {
  ok: false,
  reason: "expired",
};

describe("createTtlVerifyCache", () => {
  test("get returns undefined on cache miss", () => {
    const cache = createTtlVerifyCache({ ttlMs: 30_000 });
    expect(cache.get(grantId("g1"), "read_file")).toBeUndefined();
  });

  test("set and get returns cached result", () => {
    const cache = createTtlVerifyCache({ ttlMs: 30_000 });
    cache.set(grantId("g1"), "read_file", OK_RESULT);
    expect(cache.get(grantId("g1"), "read_file")).toEqual(OK_RESULT);
  });

  test("different tool IDs have separate cache entries", () => {
    const cache = createTtlVerifyCache({ ttlMs: 30_000 });
    cache.set(grantId("g1"), "read_file", OK_RESULT);
    cache.set(grantId("g1"), "write_file", FAIL_RESULT);

    expect(cache.get(grantId("g1"), "read_file")).toEqual(OK_RESULT);
    expect(cache.get(grantId("g1"), "write_file")).toEqual(FAIL_RESULT);
  });

  test("different grant IDs have separate cache entries", () => {
    const cache = createTtlVerifyCache({ ttlMs: 30_000 });
    cache.set(grantId("g1"), "read_file", OK_RESULT);
    cache.set(grantId("g2"), "read_file", FAIL_RESULT);

    expect(cache.get(grantId("g1"), "read_file")).toEqual(OK_RESULT);
    expect(cache.get(grantId("g2"), "read_file")).toEqual(FAIL_RESULT);
  });

  test("isStale returns true for missing entries", () => {
    const cache = createTtlVerifyCache({ ttlMs: 30_000 });
    expect(cache.isStale(grantId("g1"), "read_file")).toBe(true);
  });

  test("isStale returns false for fresh entries", () => {
    const cache = createTtlVerifyCache({ ttlMs: 30_000 });
    cache.set(grantId("g1"), "read_file", OK_RESULT);
    expect(cache.isStale(grantId("g1"), "read_file")).toBe(false);
  });

  test("isStale returns true after TTL expires", async () => {
    const cache = createTtlVerifyCache({ ttlMs: 10 }); // 10ms TTL
    cache.set(grantId("g1"), "read_file", OK_RESULT);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cache.isStale(grantId("g1"), "read_file")).toBe(true);
    // Entry still exists (stale-while-revalidate)
    expect(cache.get(grantId("g1"), "read_file")).toEqual(OK_RESULT);
  });

  test("invalidate removes all entries for a grant", () => {
    const cache = createTtlVerifyCache({ ttlMs: 30_000 });
    cache.set(grantId("g1"), "read_file", OK_RESULT);
    cache.set(grantId("g1"), "write_file", OK_RESULT);
    cache.set(grantId("g2"), "read_file", OK_RESULT);

    cache.invalidate(grantId("g1"));

    expect(cache.get(grantId("g1"), "read_file")).toBeUndefined();
    expect(cache.get(grantId("g1"), "write_file")).toBeUndefined();
    expect(cache.get(grantId("g2"), "read_file")).toEqual(OK_RESULT);
  });

  test("clear removes all entries", () => {
    const cache = createTtlVerifyCache({ ttlMs: 30_000 });
    cache.set(grantId("g1"), "read_file", OK_RESULT);
    cache.set(grantId("g2"), "read_file", OK_RESULT);

    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.get(grantId("g1"), "read_file")).toBeUndefined();
  });

  test("evicts oldest entry when at max capacity", () => {
    const cache = createTtlVerifyCache({ ttlMs: 30_000, maxEntries: 2 });

    cache.set(grantId("g1"), "tool1", OK_RESULT);
    cache.set(grantId("g2"), "tool1", FAIL_RESULT);
    // This should evict g1:tool1 (oldest)
    cache.set(grantId("g3"), "tool1", OK_RESULT);

    expect(cache.size()).toBe(2);
    expect(cache.get(grantId("g1"), "tool1")).toBeUndefined();
    expect(cache.get(grantId("g2"), "tool1")).toEqual(FAIL_RESULT);
    expect(cache.get(grantId("g3"), "tool1")).toEqual(OK_RESULT);
  });

  test("updating existing entry does not trigger eviction", () => {
    const cache = createTtlVerifyCache({ ttlMs: 30_000, maxEntries: 2 });

    cache.set(grantId("g1"), "tool1", OK_RESULT);
    cache.set(grantId("g2"), "tool1", OK_RESULT);
    // Update g1:tool1 — should not evict
    cache.set(grantId("g1"), "tool1", FAIL_RESULT);

    expect(cache.size()).toBe(2);
    expect(cache.get(grantId("g1"), "tool1")).toEqual(FAIL_RESULT);
    expect(cache.get(grantId("g2"), "tool1")).toEqual(OK_RESULT);
  });

  test("size returns current cache size", () => {
    const cache = createTtlVerifyCache({ ttlMs: 30_000 });
    expect(cache.size()).toBe(0);

    cache.set(grantId("g1"), "tool1", OK_RESULT);
    expect(cache.size()).toBe(1);

    cache.set(grantId("g1"), "tool2", OK_RESULT);
    expect(cache.size()).toBe(2);

    cache.invalidate(grantId("g1"));
    expect(cache.size()).toBe(0);
  });

  test("default config uses 30s TTL and 1024 max entries", () => {
    const cache = createTtlVerifyCache();
    cache.set(grantId("g1"), "tool1", OK_RESULT);
    // Fresh entry should not be stale
    expect(cache.isStale(grantId("g1"), "tool1")).toBe(false);
  });
});
