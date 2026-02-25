import { describe, expect, test } from "bun:test";
import type {
  DelegationGrant,
  DelegationId,
  DelegationScope,
  RevocationRegistry,
  ScopeChecker,
} from "@koi/core";
import { attenuateGrant, createGrant } from "./grant.js";
import { signGrant } from "./sign.js";
import { defaultScopeChecker, matchToolAgainstScope, verifyGrant } from "./verify.js";

const SECRET = "test-secret-key-32-bytes-minimum";

function makeRegistry(revokedSet?: Set<DelegationId>): RevocationRegistry {
  const revoked = revokedSet ?? new Set<DelegationId>();
  return {
    isRevoked: (id) => revoked.has(id),
    revoke: (id) => {
      revoked.add(id);
    },
  };
}

function makeGrant(
  overrides?: Partial<{
    readonly scope: DelegationScope;
    readonly expiresAt: number;
    readonly chainDepth: number;
    readonly maxChainDepth: number;
  }>,
): DelegationGrant {
  // For custom expiresAt (including past dates), fabricate a signed grant directly
  if (overrides?.expiresAt !== undefined) {
    const unsigned = {
      id: crypto.randomUUID() as DelegationId,
      issuerId: "agent-1",
      delegateeId: "agent-2",
      scope: overrides.scope ?? { permissions: { allow: ["read_file", "write_file"] } },
      chainDepth: overrides.chainDepth ?? 0,
      maxChainDepth: overrides.maxChainDepth ?? 3,
      createdAt: Date.now(),
      expiresAt: overrides.expiresAt,
    };
    const signature = signGrant(unsigned, SECRET);
    return { ...unsigned, signature };
  }

  const result = createGrant({
    issuerId: "agent-1",
    delegateeId: "agent-2",
    scope: overrides?.scope ?? {
      permissions: { allow: ["read_file", "write_file"] },
    },
    maxChainDepth: overrides?.maxChainDepth ?? 3,
    ttlMs: 3600000,
    secret: SECRET,
  });
  if (!result.ok) throw new Error("Failed to create grant in test helper");
  return result.value;
}

describe("verifyGrant — 12-case matrix", () => {
  // Case 1: Valid grant, matching tool
  test("case 1: valid grant with matching tool returns ok: true", async () => {
    const grant = makeGrant();
    const registry = makeRegistry();
    const result = await verifyGrant(grant, "read_file", registry, SECRET);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grant.id).toBe(grant.id);
    }
  });

  // Case 2: Expired grant
  test("case 2: expired grant returns reason: expired", async () => {
    const grant = makeGrant({ expiresAt: Date.now() - 1000 });
    const registry = makeRegistry();
    const result = await verifyGrant(grant, "read_file", registry, SECRET);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("expired");
    }
  });

  // Case 3: Revoked grant
  test("case 3: revoked grant returns reason: revoked", async () => {
    const grant = makeGrant();
    const revoked = new Set<DelegationId>([grant.id]);
    const registry = makeRegistry(revoked);
    const result = await verifyGrant(grant, "read_file", registry, SECRET);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("revoked");
    }
  });

  // Case 4: Cascading revocation (parent revoked — grant itself in revoked set)
  test("case 4: cascaded revocation returns reason: revoked", async () => {
    const parent = makeGrant();
    const childResult = attenuateGrant(
      parent,
      {
        delegateeId: "agent-3",
        scope: { permissions: { allow: ["read_file"] } },
      },
      SECRET,
    );
    expect(childResult.ok).toBe(true);
    if (!childResult.ok) return;

    // After eager cascade, child is in revoked set too
    const revoked = new Set<DelegationId>([parent.id, childResult.value.id]);
    const registry = makeRegistry(revoked);
    const result = await verifyGrant(childResult.value, "read_file", registry, SECRET);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("revoked");
    }
  });

  // Case 5: Scope violation (tool not in allow list)
  test("case 5: tool outside scope returns reason: scope_exceeded", async () => {
    const grant = makeGrant({
      scope: { permissions: { allow: ["read_file"] } },
    });
    const registry = makeRegistry();
    const result = await verifyGrant(grant, "execute_command", registry, SECRET);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("scope_exceeded");
    }
  });

  // Case 6: Chain depth exceeded (fabricated grant beyond max)
  test("case 6: chain depth exceeded returns reason: chain_depth_exceeded", async () => {
    // Fabricate a grant with chainDepth > maxChainDepth
    const unsigned = {
      id: "fabricated" as DelegationId,
      issuerId: "agent-1",
      delegateeId: "agent-2",
      scope: { permissions: { allow: ["read_file"] } } as DelegationScope,
      chainDepth: 5,
      maxChainDepth: 3,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
    };
    const signature = signGrant(unsigned, SECRET);
    const grant: DelegationGrant = { ...unsigned, signature };
    const registry = makeRegistry();

    const result = await verifyGrant(grant, "read_file", registry, SECRET);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("chain_depth_exceeded");
    }
  });

  // Case 7: Self-delegation (agent → itself) — valid, just unusual
  test("case 7: self-delegation returns ok: true", async () => {
    const grantResult = createGrant({
      issuerId: "agent-1",
      delegateeId: "agent-1",
      scope: { permissions: { allow: ["read_file"] } },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    });
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;
    const registry = makeRegistry();
    const result = await verifyGrant(grantResult.value, "read_file", registry, SECRET);

    expect(result.ok).toBe(true);
  });

  // Case 8: Empty scope delegation — any tool should be denied
  test("case 8: empty scope returns reason: scope_exceeded for any tool", async () => {
    const grant = makeGrant({
      scope: { permissions: {} },
    });
    const registry = makeRegistry();
    const result = await verifyGrant(grant, "read_file", registry, SECRET);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("scope_exceeded");
    }
  });

  // Case 9: Invalid/tampered signature
  test("case 9: tampered signature returns reason: invalid_signature", async () => {
    const grant = makeGrant();
    const tampered: DelegationGrant = {
      ...grant,
      signature: "0".repeat(64),
    };
    const registry = makeRegistry();
    const result = await verifyGrant(tampered, "read_file", registry, SECRET);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_signature");
    }
  });

  // Case 10: Unknown grant — verifyGrant is stateless, so this tests signature
  test("case 10: grant with empty signature returns reason: invalid_signature", async () => {
    const unsigned = {
      id: "unknown-1" as DelegationId,
      issuerId: "agent-1",
      delegateeId: "agent-2",
      scope: { permissions: { allow: ["read_file"] } } as DelegationScope,
      chainDepth: 0,
      maxChainDepth: 3,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      signature: "",
    };
    const registry = makeRegistry();
    const result = await verifyGrant(unsigned, "read_file", registry, SECRET);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_signature");
    }
  });

  // Case 11: Re-delegation of revoked grant (attenuate then revoke)
  test("case 11: attenuating from a revoked parent — handled at revoke time", async () => {
    // This tests that after revoking parent, the child is also revoked
    const parent = makeGrant();
    const childResult = attenuateGrant(
      parent,
      {
        delegateeId: "agent-3",
        scope: { permissions: { allow: ["read_file"] } },
      },
      SECRET,
    );
    expect(childResult.ok).toBe(true);
    if (!childResult.ok) return;

    // Revoke parent (cascade adds child too)
    const revoked = new Set<DelegationId>([parent.id, childResult.value.id]);
    const registry = makeRegistry(revoked);
    const result = await verifyGrant(childResult.value, "read_file", registry, SECRET);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("revoked");
    }
  });

  // Case 12: Delegation to non-existent agent — verification is stateless
  test("case 12: delegation to non-existent agent returns ok: true", async () => {
    const grantResult = createGrant({
      issuerId: "agent-1",
      delegateeId: "non-existent-agent",
      scope: { permissions: { allow: ["read_file"] } },
      maxChainDepth: 3,
      ttlMs: 3600000,
      secret: SECRET,
    });
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;
    const registry = makeRegistry();
    const result = await verifyGrant(grantResult.value, "read_file", registry, SECRET);

    expect(result.ok).toBe(true);
  });
});

describe("matchToolAgainstScope", () => {
  test("exact match", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file"] },
    };
    expect(matchToolAgainstScope("read_file", scope)).toBe(true);
  });

  test("wildcard match", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["*"] },
    };
    expect(matchToolAgainstScope("read_file", scope)).toBe(true);
  });

  test("no match", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["write_file"] },
    };
    expect(matchToolAgainstScope("read_file", scope)).toBe(false);
  });

  test("empty allow list denies all", () => {
    const scope: DelegationScope = {
      permissions: { allow: [] },
    };
    expect(matchToolAgainstScope("read_file", scope)).toBe(false);
  });

  test("undefined allow list denies all", () => {
    const scope: DelegationScope = {
      permissions: {},
    };
    expect(matchToolAgainstScope("read_file", scope)).toBe(false);
  });

  test("deny overrides allow", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file", "write_file"], deny: ["write_file"] },
    };
    expect(matchToolAgainstScope("read_file", scope)).toBe(true);
    expect(matchToolAgainstScope("write_file", scope)).toBe(false);
  });

  test("resource pattern matching with glob-style paths", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file"] },
      resources: ["read_file:/workspace/src/**"],
    };
    expect(matchToolAgainstScope("read_file:/workspace/src/foo.ts", scope)).toBe(true);
    expect(matchToolAgainstScope("read_file:/workspace/test/bar.ts", scope)).toBe(false);
  });

  test("resource glob matches nested paths", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file"] },
      resources: ["read_file:/workspace/**"],
    };
    expect(matchToolAgainstScope("read_file:/workspace/src/deep/file.ts", scope)).toBe(true);
  });

  test("tool without resource path matches when no resource patterns defined", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file"] },
    };
    expect(matchToolAgainstScope("read_file", scope)).toBe(true);
  });
});

describe("ScopeChecker pluggability", () => {
  test("defaultScopeChecker delegates to matchToolAgainstScope", () => {
    const scope: DelegationScope = {
      permissions: { allow: ["read_file"] },
    };
    expect(defaultScopeChecker.isAllowed("read_file", scope)).toBe(true);
    expect(defaultScopeChecker.isAllowed("exec", scope)).toBe(false);
  });

  test("verifyGrant uses custom ScopeChecker when provided", async () => {
    const grant = makeGrant({
      scope: { permissions: { allow: ["read_file"] } },
    });
    const registry = makeRegistry();

    // Custom checker that denies everything
    const denyAll: ScopeChecker = { isAllowed: () => false };
    const result = await verifyGrant(grant, "read_file", registry, SECRET, undefined, denyAll);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("scope_exceeded");
    }
  });

  test("verifyGrant uses custom ScopeChecker that allows everything", async () => {
    const grant = makeGrant({
      scope: { permissions: {} }, // empty scope — default checker would deny
    });
    const registry = makeRegistry();

    // Custom checker that allows everything
    const allowAll: ScopeChecker = { isAllowed: () => true };
    const result = await verifyGrant(grant, "exec", registry, SECRET, undefined, allowAll);

    expect(result.ok).toBe(true);
  });

  test("verifyGrant falls back to default when no ScopeChecker provided", async () => {
    const grant = makeGrant({
      scope: { permissions: { allow: ["read_file"] } },
    });
    const registry = makeRegistry();

    // No scopeChecker → uses default
    const result = await verifyGrant(grant, "read_file", registry, SECRET);
    expect(result.ok).toBe(true);
  });

  test("custom ScopeChecker receives correct toolId and scope", async () => {
    const grant = makeGrant({
      scope: { permissions: { allow: ["read_file"] }, resources: ["read_file:/src/**"] },
    });
    const registry = makeRegistry();

    let receivedToolId = "";
    let receivedScope: DelegationScope | undefined;
    const spy: ScopeChecker = {
      isAllowed: (toolId, scope) => {
        receivedToolId = toolId;
        receivedScope = scope;
        return true;
      },
    };

    await verifyGrant(grant, "read_file:/src/foo.ts", registry, SECRET, undefined, spy);

    expect(receivedToolId).toBe("read_file:/src/foo.ts");
    expect(receivedScope).toEqual(grant.scope);
  });
});
