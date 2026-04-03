import { afterEach, describe, expect, test } from "bun:test";
import type { DelegationScope } from "@koi/core";
import {
  agentId,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_SANDBOXED_POLICY,
  DEFAULT_UNSANDBOXED_POLICY,
} from "@koi/core";
import { createDelegationManager } from "../delegation-manager.js";
import { createDelegationGrantTool } from "./grant.js";

const SECRET = "test-secret-key-32-bytes-minimum";
const DEFAULT_CONFIG = {
  secret: SECRET,
  maxChainDepth: 3,
  defaultTtlMs: 3600000,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
} as const;

describe("createDelegationGrantTool", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  });

  function setup(): {
    readonly manager: ReturnType<typeof createDelegationManager>;
    readonly tool: ReturnType<typeof createDelegationGrantTool>;
  } {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);
    const tool = createDelegationGrantTool(
      manager,
      agentId("owner"),
      "delegation",
      DEFAULT_UNSANDBOXED_POLICY,
    );
    return { manager, tool };
  }

  test("descriptor has correct name and schema", () => {
    const { tool } = setup();
    expect(tool.descriptor.name).toBe("delegation_grant");
    expect(tool.policy.sandbox).toBe(false);
    expect(tool.descriptor.inputSchema).toHaveProperty("required");
  });

  test("successful grant returns grantId and scope", async () => {
    const { tool, manager } = setup();
    const result = await tool.execute({
      delegateeId: "agent-2",
      permissions: { allow: ["read_file"] },
    });

    const output = result as { grantId: string; scope: DelegationScope; expiresAt: number };
    expect(output.grantId).toBeDefined();
    expect(output.scope.permissions.allow).toEqual(["read_file"]);
    expect(output.expiresAt).toBeGreaterThan(Date.now());

    // Verify stored in manager
    expect(manager.list(agentId("agent-2"))).toHaveLength(1);
  });

  test("grant with resources and ttlMs", async () => {
    const { tool } = setup();
    const result = await tool.execute({
      delegateeId: "agent-2",
      permissions: { allow: ["read_file"] },
      resources: ["read_file:/src/**"],
      ttlMs: 60000,
    });

    const output = result as { grantId: string; scope: DelegationScope; expiresAt: number };
    expect(output.scope.resources).toEqual(["read_file:/src/**"]);
  });

  test("throws on missing delegateeId", async () => {
    const { tool } = setup();
    await expect(tool.execute({ permissions: { allow: ["read_file"] } })).rejects.toThrow(
      "delegateeId",
    );
  });

  test("throws on missing permissions", async () => {
    const { tool } = setup();
    await expect(tool.execute({ delegateeId: "agent-2" })).rejects.toThrow("permissions");
  });

  test("throws on invalid ttlMs", async () => {
    const { tool } = setup();
    await expect(
      tool.execute({
        delegateeId: "agent-2",
        permissions: { allow: ["read_file"] },
        ttlMs: -1,
      }),
    ).rejects.toThrow("ttlMs");
  });

  test("uses custom prefix", () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);
    const tool = createDelegationGrantTool(
      manager,
      agentId("owner"),
      "custom",
      DEFAULT_SANDBOXED_POLICY,
    );
    expect(tool.descriptor.name).toBe("custom_grant");
    expect(tool.policy.sandbox).toBe(true);
  });

  // -----------------------------------------------------------------------
  // parentGrantId (attenuate via grant tool)
  // -----------------------------------------------------------------------

  test("attenuates parent grant when parentGrantId is provided", async () => {
    const { tool, manager } = setup();

    // Create root grant first
    const rootResult = await tool.execute({
      delegateeId: "agent-2",
      permissions: { allow: ["read_file", "write_file"] },
    });
    const root = rootResult as { grantId: string; scope: DelegationScope; expiresAt: number };

    // Attenuate using parentGrantId
    const childResult = await tool.execute({
      delegateeId: "agent-3",
      permissions: { allow: ["read_file"] },
      parentGrantId: root.grantId,
    });
    const child = childResult as { grantId: string; scope: DelegationScope; expiresAt: number };

    expect(child.grantId).toBeDefined();
    expect(child.grantId).not.toBe(root.grantId);
    expect(child.scope.permissions.allow).toEqual(["read_file"]);

    // Verify both grants exist
    expect(manager.list()).toHaveLength(2);
  });

  test("throws when parentGrantId does not exist", async () => {
    const { tool } = setup();
    await expect(
      tool.execute({
        delegateeId: "agent-3",
        permissions: { allow: ["read_file"] },
        parentGrantId: "nonexistent-grant-id",
      }),
    ).rejects.toThrow("Grant failed");
  });

  test("throws when attenuated scope exceeds parent", async () => {
    const { tool } = setup();

    // Create root grant with limited permissions
    const rootResult = await tool.execute({
      delegateeId: "agent-2",
      permissions: { allow: ["read_file"] },
    });
    const root = rootResult as { grantId: string; scope: DelegationScope; expiresAt: number };

    // Try to attenuate with wider scope
    await expect(
      tool.execute({
        delegateeId: "agent-3",
        permissions: { allow: ["read_file", "write_file"] },
        parentGrantId: root.grantId,
      }),
    ).rejects.toThrow("Grant failed");
  });

  test("schema includes parentGrantId property", () => {
    const { tool } = setup();
    const schema = tool.descriptor.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("parentGrantId");
  });
});
