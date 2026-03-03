import { afterEach, describe, expect, test } from "bun:test";
import { agentId, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "@koi/core";
import { createDelegationManager } from "../delegation-manager.js";
import { createDelegationRevokeTool } from "./revoke.js";

const SECRET = "test-secret-key-32-bytes-minimum";
const DEFAULT_CONFIG = {
  secret: SECRET,
  maxChainDepth: 3,
  defaultTtlMs: 3600000,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
} as const;

describe("createDelegationRevokeTool", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  });

  test("descriptor has correct name and schema", () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);
    const tool = createDelegationRevokeTool(manager, "delegation", "verified");
    expect(tool.descriptor.name).toBe("delegation_revoke");
    expect(tool.trustTier).toBe("verified");
  });

  test("revokes an existing grant", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const grantResult = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
    });
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;

    const tool = createDelegationRevokeTool(manager, "delegation", "verified");
    const result = await tool.execute({ grantId: grantResult.value.id });

    const output = result as { revokedIds: readonly string[] };
    expect(output.revokedIds).toContain(grantResult.value.id);
    expect(manager.list()).toHaveLength(0);
  });

  test("revokes with cascade", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const root = await manager.grant(agentId("agent-1"), agentId("agent-2"), {
      permissions: { allow: ["read_file", "write_file"] },
    });
    expect(root.ok).toBe(true);
    if (!root.ok) return;

    const child = await manager.attenuate(root.value.id, agentId("agent-3"), {
      permissions: { allow: ["read_file"] },
    });
    expect(child.ok).toBe(true);

    const tool = createDelegationRevokeTool(manager, "delegation", "verified");
    const result = await tool.execute({ grantId: root.value.id, cascade: true });

    const output = result as { revokedIds: readonly string[] };
    expect(output.revokedIds).toHaveLength(2);
  });

  test("throws on missing grantId", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);
    const tool = createDelegationRevokeTool(manager, "delegation", "verified");

    await expect(tool.execute({})).rejects.toThrow("grantId");
  });

  test("uses custom prefix", () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);
    const tool = createDelegationRevokeTool(manager, "custom", "sandbox");
    expect(tool.descriptor.name).toBe("custom_revoke");
  });
});
