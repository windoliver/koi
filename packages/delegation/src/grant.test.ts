import { describe, expect, test } from "bun:test";
import type { DelegationGrant } from "@koi/core";
import { attenuateGrant, createGrant } from "./grant.js";
import { verifySignature } from "./sign.js";

const SECRET = "test-secret-key-32-bytes-minimum";

describe("createGrant", () => {
  test("creates a root grant with chainDepth=0 and valid signature", () => {
    const grant = createGrant({
      issuerId: "agent-1",
      delegateeId: "agent-2",
      scope: { permissions: { allow: ["read_file", "write_file"] } },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    });

    expect(grant.chainDepth).toBe(0);
    expect(grant.parentId).toBeUndefined();
    expect(grant.issuerId).toBe("agent-1");
    expect(grant.delegateeId).toBe("agent-2");
    expect(grant.maxChainDepth).toBe(3);
    expect(grant.expiresAt).toBeGreaterThan(grant.createdAt);
    expect(grant.expiresAt - grant.createdAt).toBe(3600000);
    expect(verifySignature(grant, SECRET)).toBe(true);
  });

  test("throws on empty issuerId", () => {
    expect(() =>
      createGrant({
        issuerId: "",
        delegateeId: "agent-2",
        scope: { permissions: { allow: ["read_file"] } },
        maxChainDepth: 3,
        ttlMs: 3600000,
        secret: SECRET,
      }),
    ).toThrow("issuerId and delegateeId must be non-empty");
  });

  test("throws on non-positive ttlMs", () => {
    expect(() =>
      createGrant({
        issuerId: "agent-1",
        delegateeId: "agent-2",
        scope: { permissions: { allow: ["read_file"] } },
        maxChainDepth: 3,
        ttlMs: 0,
        secret: SECRET,
      }),
    ).toThrow("ttlMs must be positive");
  });

  test("throws on negative maxChainDepth", () => {
    expect(() =>
      createGrant({
        issuerId: "agent-1",
        delegateeId: "agent-2",
        scope: { permissions: { allow: ["read_file"] } },
        maxChainDepth: -1,
        ttlMs: 3600000,
        secret: SECRET,
      }),
    ).toThrow("maxChainDepth must be >= 0");
  });

  test("each grant gets a unique DelegationId", () => {
    const params = {
      issuerId: "agent-1",
      delegateeId: "agent-2",
      scope: { permissions: { allow: ["*"] } },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    };
    const g1 = createGrant(params);
    const g2 = createGrant(params);

    expect(g1.id).not.toBe(g2.id);
  });
});

describe("attenuateGrant", () => {
  function makeParent(): DelegationGrant {
    return createGrant({
      issuerId: "agent-1",
      delegateeId: "agent-2",
      scope: {
        permissions: { allow: ["read_file", "write_file"], deny: ["delete_file"] },
        resources: ["read_file:/workspace/**", "write_file:/workspace/src/**"],
        maxBudget: 100,
      },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    });
  }

  test("attenuate with narrower scope succeeds", () => {
    const parent = makeParent();
    const result = attenuateGrant(
      parent,
      {
        delegateeId: "agent-3",
        scope: {
          permissions: { allow: ["read_file"], deny: ["delete_file"] },
          resources: ["read_file:/workspace/**"],
          maxBudget: 50,
        },
      },
      SECRET,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.chainDepth).toBe(1);
      expect(result.value.parentId).toBe(parent.id);
      expect(result.value.issuerId).toBe("agent-2"); // delegatee becomes issuer
      expect(result.value.delegateeId).toBe("agent-3");
      expect(result.value.maxChainDepth).toBe(3);
      expect(result.value.expiresAt).toBeLessThanOrEqual(parent.expiresAt);
      expect(verifySignature(result.value, SECRET)).toBe(true);
    }
  });

  test("attenuate with wider scope is rejected", () => {
    const parent = makeParent();
    const result = attenuateGrant(
      parent,
      {
        delegateeId: "agent-3",
        scope: {
          permissions: { allow: ["read_file", "write_file", "execute_command"] },
        },
      },
      SECRET,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("scope");
    }
  });

  test("attenuate with earlier expiry succeeds", () => {
    const parent = makeParent();
    const result = attenuateGrant(
      parent,
      {
        delegateeId: "agent-3",
        scope: {
          permissions: { allow: ["read_file"], deny: ["delete_file"] },
          maxBudget: 50,
        },
        ttlMs: 1800000, // 30 minutes — less than parent's 1 hour
      },
      SECRET,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.expiresAt).toBeLessThan(parent.expiresAt);
    }
  });

  test("attenuate with later expiry is rejected", () => {
    const parent = makeParent();
    const result = attenuateGrant(
      parent,
      {
        delegateeId: "agent-3",
        scope: {
          permissions: { allow: ["read_file"], deny: ["delete_file"] },
          maxBudget: 50,
        },
        ttlMs: 7200000, // 2 hours — exceeds parent's 1 hour
      },
      SECRET,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("expir");
    }
  });

  test("attenuate with depth exceeded is rejected", () => {
    // Create parent at maxChainDepth=1, chainDepth=0
    const parent = createGrant({
      issuerId: "agent-1",
      delegateeId: "agent-2",
      scope: { permissions: { allow: ["read_file"] } },
      maxChainDepth: 1,
      ttlMs: 3600000,
      secret: SECRET,
    });

    // First attenuation: depth 0 → 1 (== maxChainDepth 1)
    const child = attenuateGrant(
      parent,
      {
        delegateeId: "agent-3",
        scope: { permissions: { allow: ["read_file"] } },
      },
      SECRET,
    );
    expect(child.ok).toBe(true);

    if (child.ok) {
      // Second attenuation: depth 1 → 2 (exceeds maxChainDepth 1)
      const grandchild = attenuateGrant(
        child.value,
        {
          delegateeId: "agent-4",
          scope: { permissions: { allow: ["read_file"] } },
        },
        SECRET,
      );
      expect(grandchild.ok).toBe(false);
      if (!grandchild.ok) {
        expect(grandchild.error.code).toBe("PERMISSION");
        expect(grandchild.error.message).toContain("chain depth");
      }
    }
  });

  test("attenuate with lower budget succeeds", () => {
    const parent = makeParent();
    const result = attenuateGrant(
      parent,
      {
        delegateeId: "agent-3",
        scope: {
          permissions: { allow: ["read_file"], deny: ["delete_file"] },
          maxBudget: 50,
        },
      },
      SECRET,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.scope.maxBudget).toBe(50);
    }
  });

  test("attenuate with higher budget is rejected", () => {
    const parent = makeParent();
    const result = attenuateGrant(
      parent,
      {
        delegateeId: "agent-3",
        scope: {
          permissions: { allow: ["read_file"], deny: ["delete_file"] },
          maxBudget: 200,
        },
      },
      SECRET,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("budget");
    }
  });

  test("attenuate must preserve parent deny rules", () => {
    const parent = makeParent();
    // Try to attenuate without including the parent's deny rule
    const result = attenuateGrant(
      parent,
      {
        delegateeId: "agent-3",
        scope: {
          permissions: { allow: ["read_file"] },
          // Missing deny: ["delete_file"] from parent
        },
      },
      SECRET,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("deny");
    }
  });
});
