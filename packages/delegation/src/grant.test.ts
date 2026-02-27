import { describe, expect, test } from "bun:test";
import type { DelegationGrant } from "@koi/core";
import { agentId } from "@koi/core";
import { attenuateGrant, createGrant } from "./grant.js";
import { verifySignature } from "./sign.js";

const SECRET = "test-secret-key-32-bytes-minimum";

describe("createGrant", () => {
  test("creates a root grant with chainDepth=0 and valid proof", () => {
    const result = createGrant({
      issuerId: agentId("agent-1"),
      delegateeId: agentId("agent-2"),
      scope: { permissions: { allow: ["read_file", "write_file"] } },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const grant = result.value;

    expect(grant.chainDepth).toBe(0);
    expect(grant.parentId).toBeUndefined();
    expect(grant.issuerId).toBe(agentId("agent-1"));
    expect(grant.delegateeId).toBe(agentId("agent-2"));
    expect(grant.maxChainDepth).toBe(3);
    expect(grant.expiresAt).toBeGreaterThan(grant.createdAt);
    expect(grant.expiresAt - grant.createdAt).toBe(3600000);
    expect(grant.proof.kind).toBe("hmac-sha256");
    expect(verifySignature(grant, SECRET)).toBe(true);
  });

  test("returns error on empty issuerId", () => {
    const result = createGrant({
      issuerId: agentId(""),
      delegateeId: agentId("agent-2"),
      scope: { permissions: { allow: ["read_file"] } },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("issuerId and delegateeId must be non-empty");
    }
  });

  test("returns error on non-positive ttlMs", () => {
    const result = createGrant({
      issuerId: agentId("agent-1"),
      delegateeId: agentId("agent-2"),
      scope: { permissions: { allow: ["read_file"] } },
      maxChainDepth: 3,
      ttlMs: 0,
      secret: SECRET,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("ttlMs must be positive");
    }
  });

  test("returns error on negative maxChainDepth", () => {
    const result = createGrant({
      issuerId: agentId("agent-1"),
      delegateeId: agentId("agent-2"),
      scope: { permissions: { allow: ["read_file"] } },
      maxChainDepth: -1,
      ttlMs: 3600000,
      secret: SECRET,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("maxChainDepth must be >= 0");
    }
  });

  test("each grant gets a unique DelegationId", () => {
    const params = {
      issuerId: agentId("agent-1"),
      delegateeId: agentId("agent-2"),
      scope: { permissions: { allow: ["*"] } },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    };
    const r1 = createGrant(params);
    const r2 = createGrant(params);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value.id).not.toBe(r2.value.id);
    }
  });
});

describe("attenuateGrant", () => {
  function makeParent(): DelegationGrant {
    const result = createGrant({
      issuerId: agentId("agent-1"),
      delegateeId: agentId("agent-2"),
      scope: {
        permissions: { allow: ["read_file", "write_file"], deny: ["delete_file"] },
        resources: ["read_file:/workspace/**", "write_file:/workspace/src/**"],
      },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    });
    if (!result.ok) throw new Error("Failed to create parent grant");
    return result.value;
  }

  test("attenuate with narrower scope succeeds", () => {
    const parent = makeParent();
    const result = attenuateGrant(
      parent,
      {
        delegateeId: agentId("agent-3"),
        scope: {
          permissions: { allow: ["read_file"], deny: ["delete_file"] },
          resources: ["read_file:/workspace/**"],
        },
      },
      SECRET,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.chainDepth).toBe(1);
      expect(result.value.parentId).toBe(parent.id);
      expect(result.value.issuerId).toBe(agentId("agent-2")); // delegatee becomes issuer
      expect(result.value.delegateeId).toBe(agentId("agent-3"));
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
        delegateeId: agentId("agent-3"),
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
        delegateeId: agentId("agent-3"),
        scope: {
          permissions: { allow: ["read_file"], deny: ["delete_file"] },
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
        delegateeId: agentId("agent-3"),
        scope: {
          permissions: { allow: ["read_file"], deny: ["delete_file"] },
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
    const parentResult = createGrant({
      issuerId: agentId("agent-1"),
      delegateeId: agentId("agent-2"),
      scope: { permissions: { allow: ["read_file"] } },
      maxChainDepth: 1,
      ttlMs: 3600000,
      secret: SECRET,
    });
    expect(parentResult.ok).toBe(true);
    if (!parentResult.ok) return;
    const parent = parentResult.value;

    // First attenuation: depth 0 → 1 (== maxChainDepth 1)
    const child = attenuateGrant(
      parent,
      {
        delegateeId: agentId("agent-3"),
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
          delegateeId: agentId("agent-4"),
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

  test("attenuate must preserve parent deny rules", () => {
    const parent = makeParent();
    // Try to attenuate without including the parent's deny rule
    const result = attenuateGrant(
      parent,
      {
        delegateeId: agentId("agent-3"),
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
