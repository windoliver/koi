import { afterEach, describe, expect, test } from "bun:test";
import type { DelegationScope } from "@koi/core";
import { agentId, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@koi/core";
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
    const tool = createDelegationGrantTool(manager, agentId("owner"), "delegation", "verified");
    return { manager, tool };
  }

  test("descriptor has correct name and schema", () => {
    const { tool } = setup();
    expect(tool.descriptor.name).toBe("delegation_grant");
    expect(tool.trustTier).toBe("verified");
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
    const tool = createDelegationGrantTool(manager, agentId("owner"), "custom", "sandbox");
    expect(tool.descriptor.name).toBe("custom_grant");
    expect(tool.trustTier).toBe("sandbox");
  });
});
