/**
 * Integration tests for the delegation bridge in createGovernanceStack().
 *
 * Verifies:
 * - delegationBridge config attaches DelegationComponentProvider
 * - onGrant/onRevoke hooks are called when tools execute
 * - Grant is rolled back when onGrant hook fails
 * - Correct ReBAC tuples are constructed from resource patterns
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { DelegationGrant, DelegationId, KoiError, PermissionBackend, Result } from "@koi/core";
import { agentId, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@koi/core";
import { createDelegationManager, parseResourcePattern } from "@koi/delegation";
import type { NexusClient } from "@koi/nexus-client";
import { createNexusPermissionBackend } from "@koi/permissions-nexus";
import { createGovernanceStack } from "../governance-stack.js";

const SECRET = "test-secret-key-32-bytes-minimum";
const DEFAULT_MANAGER_CONFIG = {
  secret: SECRET,
  maxChainDepth: 3,
  defaultTtlMs: 3600000,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
} as const;

// ---------------------------------------------------------------------------
// Mock Nexus RPC capture
// ---------------------------------------------------------------------------

interface CapturedRpc {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function createMockNexusGranter(): {
  readonly calls: CapturedRpc[];
  readonly onGrant: (grant: DelegationGrant) => Promise<void>;
} {
  const calls: CapturedRpc[] = [];

  return {
    calls,
    onGrant: async (grant: DelegationGrant): Promise<void> => {
      const resources = grant.scope.resources ?? [];
      for (const resource of resources) {
        const parsed = parseResourcePattern(resource);
        if (parsed === undefined) continue;
        calls.push({
          method: "permissions.grant",
          params: {
            subject: `agent:${grant.delegateeId}`,
            relation: parsed.tool === "write_file" ? "writer" : "reader",
            object: `folder:${parsed.path}`,
          },
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("delegation bridge in createGovernanceStack", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  });

  test("delegationBridge adds providers to the bundle", () => {
    const manager = createDelegationManager({ config: DEFAULT_MANAGER_CONFIG });
    cleanups.push(manager.dispose);

    const bundle = createGovernanceStack({
      delegationBridge: { manager },
    });

    // Provider for delegation tools should be included
    expect(bundle.providers.length).toBeGreaterThanOrEqual(1);
    const delegationProvider = bundle.providers.find((p) => p.name === "delegation-tools");
    expect(delegationProvider).toBeDefined();
  });

  test("no delegationBridge → no delegation providers", () => {
    const bundle = createGovernanceStack({});

    const delegationProvider = bundle.providers.find((p) => p.name === "delegation-tools");
    expect(delegationProvider).toBeUndefined();
  });

  test("onGrant hook receives grant and constructs ReBAC tuples", async () => {
    const nexus = createMockNexusGranter();
    const manager = createDelegationManager({
      config: DEFAULT_MANAGER_CONFIG,
      onGrant: nexus.onGrant,
    });
    cleanups.push(manager.dispose);

    const result = await manager.grant(agentId("parent"), agentId("child"), {
      permissions: { allow: ["read_file", "write_file"] },
      resources: ["read_file:/src/**", "write_file:/src/output/**"],
    });

    expect(result.ok).toBe(true);
    expect(nexus.calls).toHaveLength(2);
    expect(nexus.calls[0]).toEqual({
      method: "permissions.grant",
      params: {
        subject: "agent:child",
        relation: "reader",
        object: "folder:/src/**",
      },
    });
    expect(nexus.calls[1]).toEqual({
      method: "permissions.grant",
      params: {
        subject: "agent:child",
        relation: "writer",
        object: "folder:/src/output/**",
      },
    });
  });

  test("rolls back grant when onGrant hook fails", async () => {
    const manager = createDelegationManager({
      config: DEFAULT_MANAGER_CONFIG,
      onGrant: async () => {
        throw new Error("Nexus RPC failed");
      },
    });
    cleanups.push(manager.dispose);

    await expect(
      manager.grant(agentId("parent"), agentId("child"), {
        permissions: { allow: ["read_file"] },
        resources: ["read_file:/src/**"],
      }),
    ).rejects.toThrow("onGrant hook failed");

    // Grant was rolled back
    expect(manager.list()).toHaveLength(0);
  });

  test("onRevoke hook is called on revocation", async () => {
    const revokeCalls: Array<{ id: DelegationId; cascade: boolean }> = [];
    const manager = createDelegationManager({
      config: DEFAULT_MANAGER_CONFIG,
      onRevoke: (id, cascade) => {
        revokeCalls.push({ id, cascade });
      },
    });
    cleanups.push(manager.dispose);

    const result = await manager.grant(agentId("parent"), agentId("child"), {
      permissions: { allow: ["read_file"] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await manager.revoke(result.value.id, true);

    expect(revokeCalls).toHaveLength(1);
    expect(revokeCalls[0]?.id).toBe(result.value.id);
    expect(revokeCalls[0]?.cascade).toBe(true);
  });

  test("constructs correct ReBAC tuples from resource patterns", () => {
    // Verify parseResourcePattern behavior used in bridge wiring
    expect(parseResourcePattern("read_file:/src/main.ts")).toEqual({
      tool: "read_file",
      path: "/src/main.ts",
    });
    expect(parseResourcePattern("write_file:/output/**")).toEqual({
      tool: "write_file",
      path: "/output/**",
    });
    expect(parseResourcePattern("no_colon")).toBeUndefined();
  });

  test("capabilityRequest config creates bridge provider and middleware", () => {
    const manager = createDelegationManager({ config: DEFAULT_MANAGER_CONFIG });
    cleanups.push(manager.dispose);

    const bundle = createGovernanceStack({
      delegationBridge: { manager },
      capabilityRequest: { approvalTimeoutMs: 30_000, maxForwardDepth: 3 },
    });

    // Should have both delegation-tools and capability-request-bridge providers
    const delegationProvider = bundle.providers.find((p) => p.name === "delegation-tools");
    expect(delegationProvider).toBeDefined();
    const capReqProvider = bundle.providers.find((p) => p.name === "capability-request-bridge");
    expect(capReqProvider).toBeDefined();

    // Should have capability-request middleware in the stack
    const capReqMiddleware = bundle.middlewares.find((m) => m.name === "koi:capability-request");
    expect(capReqMiddleware).toBeDefined();
    expect(capReqMiddleware?.priority).toBe(125);
  });

  test("capabilityRequest without delegationBridge throws", () => {
    expect(() =>
      createGovernanceStack({
        capabilityRequest: { approvalTimeoutMs: 30_000 },
      }),
    ).toThrow("'capabilityRequest' requires 'delegationBridge'");
  });

  // -----------------------------------------------------------------------
  // Expanded delegation bridge config
  // -----------------------------------------------------------------------

  test("permissionBackend is passed through to delegation provider", () => {
    const manager = createDelegationManager({ config: DEFAULT_MANAGER_CONFIG });
    cleanups.push(manager.dispose);

    const mockBackend: PermissionBackend = {
      check: async () => ({ effect: "allow" as const }),
    };

    const bundle = createGovernanceStack({
      delegationBridge: { manager, permissionBackend: mockBackend },
    });

    // Provider is present with delegation tools
    const delegationProvider = bundle.providers.find((p) => p.name === "delegation-tools");
    expect(delegationProvider).toBeDefined();
  });

  test("nexusBackend config produces nexusHooks in bundle", () => {
    const manager = createDelegationManager({ config: DEFAULT_MANAGER_CONFIG });
    cleanups.push(manager.dispose);

    const mockNexusClient: NexusClient = {
      rpc: async <T>() =>
        ({ ok: true, value: undefined as unknown as T }) satisfies Result<T, KoiError>,
    };
    const nexusBackend = createNexusPermissionBackend({ client: mockNexusClient });

    const bundle = createGovernanceStack({
      delegationBridge: { manager, nexusBackend },
    });

    expect(bundle.nexusHooks).toBeDefined();
    expect(typeof bundle.nexusHooks?.onGrant).toBe("function");
    expect(typeof bundle.nexusHooks?.onRevoke).toBe("function");
  });

  test("no nexusBackend → no nexusHooks in bundle", () => {
    const manager = createDelegationManager({ config: DEFAULT_MANAGER_CONFIG });
    cleanups.push(manager.dispose);

    const bundle = createGovernanceStack({
      delegationBridge: { manager },
    });

    expect(bundle.nexusHooks).toBeUndefined();
  });
});
