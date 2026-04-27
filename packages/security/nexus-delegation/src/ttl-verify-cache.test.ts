import { describe, expect, test } from "bun:test";
import type { DelegationVerifyResult } from "@koi/core";
import { agentId, delegationId } from "@koi/core";
import { createTtlVerifyCache } from "./ttl-verify-cache.js";

const id = delegationId("grant-1");
const tool = "read_file";
const okResult: DelegationVerifyResult = {
  ok: true,
  grant: {
    id,
    issuerId: agentId("issuer-1"),
    delegateeId: agentId("delegatee-1"),
    scope: { permissions: { allow: ["read_file"] } },
    chainDepth: 0,
    maxChainDepth: 3,
    createdAt: 0,
    expiresAt: Date.now() + 3_600_000,
    proof: { kind: "nexus", token: "test-token" },
  },
};
const failResult: DelegationVerifyResult = { ok: false, reason: "revoked" };

describe("createTtlVerifyCache", () => {
  test("miss returns undefined", () => {
    const cache = createTtlVerifyCache({ ttlMs: 1000 });
    expect(cache.get(id, tool)).toBeUndefined();
  });

  test("set then get returns result", () => {
    const cache = createTtlVerifyCache({ ttlMs: 1000 });
    cache.set(id, tool, okResult);
    expect(cache.get(id, tool)).toEqual(okResult);
  });

  test("isStale returns false for fresh entry", () => {
    const cache = createTtlVerifyCache({ ttlMs: 1000 });
    cache.set(id, tool, okResult);
    expect(cache.isStale(id, tool)).toBe(false);
  });

  test("isStale returns true after ttl elapses (time travel via very short ttl)", async () => {
    const cache = createTtlVerifyCache({ ttlMs: 1 });
    cache.set(id, tool, okResult);
    await new Promise((r) => setTimeout(r, 5));
    expect(cache.isStale(id, tool)).toBe(true);
    // entry still served even when stale (SWR)
    expect(cache.get(id, tool)).toEqual(okResult);
  });

  test("invalidate removes all entries for a grant", () => {
    const cache = createTtlVerifyCache({ ttlMs: 1000 });
    cache.set(id, "tool_a", okResult);
    cache.set(id, "tool_b", failResult);
    cache.invalidate(id);
    expect(cache.get(id, "tool_a")).toBeUndefined();
    expect(cache.get(id, "tool_b")).toBeUndefined();
  });

  test("evicts oldest when maxEntries exceeded", () => {
    const cache = createTtlVerifyCache({ ttlMs: 1000, maxEntries: 2 });
    cache.set(id, "t1", okResult);
    cache.set(id, "t2", okResult);
    cache.set(id, "t3", okResult); // evicts t1
    expect(cache.size()).toBe(2);
    expect(cache.get(id, "t1")).toBeUndefined();
  });
});
