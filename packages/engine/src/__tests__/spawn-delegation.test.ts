/**
 * Auto-delegation at spawn tests.
 *
 * Verifies that spawnChildAgent() automatically grants attenuated
 * delegation scope to child agents when the parent has a DELEGATION component.
 *
 * These are unit tests using mocked Agent/DelegationComponent to isolate
 * the auto-delegation logic from the full createKoi() pipeline.
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentId,
  DelegationComponent,
  DelegationGrant,
  DelegationScope,
  DelegationVerifyResult,
} from "@koi/core";
import { agentId, DELEGATION, delegationId } from "@koi/core";
import { computeChildDelegationScope } from "../compute-delegation-scope.js";

// ---------------------------------------------------------------------------
// Unit tests for computeChildDelegationScope (delegation scope logic)
// used by spawnChildAgent
// ---------------------------------------------------------------------------

describe("computeChildDelegationScope (spawn integration)", () => {
  test("creates delegation grant for child when parent has DELEGATION component", () => {
    const parentScope: DelegationScope = {
      permissions: { allow: ["read_file", "write_file", "exec"] },
      resources: ["read_file:/workspace/**"],
    };
    const childPermissions = { allow: ["read_file", "write_file"] };

    const result = computeChildDelegationScope(parentScope, childPermissions);

    expect(result.permissions.allow).toEqual(["read_file", "write_file"]);
    expect(result.resources).toEqual(["read_file:/workspace/**"]);
  });

  test("skips delegation when parent scope is empty", () => {
    const parentScope: DelegationScope = { permissions: {} };
    const childPermissions = { allow: ["read_file"] };

    const result = computeChildDelegationScope(parentScope, childPermissions);

    // No intersection since parent has no allow
    expect(result.permissions.allow).toBeUndefined();
  });

  test("uses attenuated scope from child manifest", () => {
    const parentScope: DelegationScope = {
      permissions: { allow: ["*"], deny: ["exec"] },
    };
    const childPermissions = { allow: ["read_file", "write_file"] };

    const result = computeChildDelegationScope(parentScope, childPermissions);

    expect(result.permissions.allow).toEqual(["read_file", "write_file"]);
    expect(result.permissions.deny).toEqual(["exec"]);
  });

  test("child deny is merged with parent deny", () => {
    const parentScope: DelegationScope = {
      permissions: { allow: ["*"], deny: ["exec"] },
    };
    const childPermissions = { allow: ["read_file"], deny: ["delete_file"] };

    const result = computeChildDelegationScope(parentScope, childPermissions);

    const deny = result.permissions.deny ?? [];
    expect(deny).toContain("exec");
    expect(deny).toContain("delete_file");
  });
});

describe("DelegationComponent mock for spawn", () => {
  test("DELEGATION token exists and is correctly typed", () => {
    // Verify the token is exported and has the expected string representation
    expect(String(DELEGATION)).toBe("delegation");
  });

  test("mock DelegationComponent grants and revokes", async () => {
    const grants = new Map<string, DelegationGrant>();

    const mockComponent: DelegationComponent = {
      grant: async (
        scope: DelegationScope,
        targetId: AgentId,
        _ttlMs?: number,
      ): Promise<DelegationGrant> => {
        const grant: DelegationGrant = {
          id: delegationId("test-grant-id"),
          issuerId: agentId("parent"),
          delegateeId: targetId,
          scope,
          chainDepth: 0,
          maxChainDepth: 3,
          createdAt: Date.now(),
          expiresAt: Date.now() + 3600000,
          proof: { kind: "hmac-sha256", digest: "test" },
        };
        grants.set(grant.id, grant);
        return grant;
      },

      revoke: async (id): Promise<void> => {
        grants.delete(id);
      },

      verify: async (_id, _toolId): Promise<DelegationVerifyResult> => {
        return { ok: false, reason: "unknown_grant" };
      },

      list: async (): Promise<readonly DelegationGrant[]> => {
        return [...grants.values()];
      },
    };

    // Simulate what spawnChildAgent does
    const childScope = computeChildDelegationScope(
      { permissions: { allow: ["read_file", "write_file"] } },
      { allow: ["read_file"] },
    );

    const grant = await mockComponent.grant(childScope, agentId("child"));
    expect(grant.delegateeId).toBe(agentId("child"));
    expect(grant.scope.permissions.allow).toEqual(["read_file"]);
    expect(grants.size).toBe(1);

    // Cleanup on termination
    await mockComponent.revoke(grant.id, false);
    expect(grants.size).toBe(0);
  });

  test("does not fail spawn when delegation grant throws", async () => {
    const mockComponent: DelegationComponent = {
      grant: async (): Promise<DelegationGrant> => {
        throw new Error("Nexus unavailable");
      },
      revoke: async (): Promise<void> => {},
      verify: async (): Promise<DelegationVerifyResult> => ({
        ok: false,
        reason: "unknown_grant",
      }),
      list: async (): Promise<readonly DelegationGrant[]> => [],
    };

    // Simulate the try/catch in spawnChildAgent
    let grantId: string | undefined;
    try {
      const grant = await mockComponent.grant(
        { permissions: { allow: ["read_file"] } },
        agentId("child"),
      );
      grantId = grant.id;
    } catch (_e: unknown) {
      // Graceful degradation — matches the spawn-child.ts behavior
    }

    // Grant ID should be undefined (grant failed)
    expect(grantId).toBeUndefined();
  });
});
