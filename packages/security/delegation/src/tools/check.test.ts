import { afterEach, describe, expect, test } from "bun:test";
import type { PermissionBackend } from "@koi/core";
import { agentId, DEFAULT_CIRCUIT_BREAKER_CONFIG, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createDelegationManager } from "../delegation-manager.js";
import { createDelegationCheckTool } from "./check.js";

const SECRET = "test-secret-key-32-bytes-minimum";
const DEFAULT_CONFIG = {
  secret: SECRET,
  maxChainDepth: 3,
  defaultTtlMs: 3600000,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
} as const;

describe("createDelegationCheckTool", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  });

  test("descriptor has correct name and schema", () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);
    const tool = createDelegationCheckTool(
      manager,
      undefined,
      agentId("owner"),
      "delegation",
      DEFAULT_UNSANDBOXED_POLICY,
    );

    expect(tool.descriptor.name).toBe("delegation_check");
    expect(tool.policy.sandbox).toBe(false);
    expect(tool.descriptor.inputSchema).toHaveProperty("required");
  });

  test("returns allowed: true for a valid grant", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const grantResult = await manager.grant(agentId("owner"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
    });
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;

    const tool = createDelegationCheckTool(
      manager,
      undefined,
      agentId("owner"),
      "delegation",
      DEFAULT_UNSANDBOXED_POLICY,
    );
    const result = await tool.execute({
      grantId: grantResult.value.id,
      permission: "read_file",
    });

    const output = result as { allowed: boolean; reason?: string };
    expect(output.allowed).toBe(true);
  });

  test("returns allowed: false for unknown grant", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const tool = createDelegationCheckTool(
      manager,
      undefined,
      agentId("owner"),
      "delegation",
      DEFAULT_UNSANDBOXED_POLICY,
    );
    const result = await tool.execute({
      grantId: "nonexistent-grant",
      permission: "read_file",
    });

    const output = result as { allowed: boolean; reason?: string };
    expect(output.allowed).toBe(false);
    expect(output.reason).toBe("unknown_grant");
  });

  test("checks permission backend when provided", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const grantResult = await manager.grant(agentId("owner"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
    });
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;

    const backend: PermissionBackend = {
      check: async () => ({ effect: "deny" as const, reason: "backend denied" }),
    };

    const tool = createDelegationCheckTool(
      manager,
      backend,
      agentId("owner"),
      "delegation",
      DEFAULT_UNSANDBOXED_POLICY,
    );
    const result = await tool.execute({
      grantId: grantResult.value.id,
      permission: "read_file",
    });

    const output = result as { allowed: boolean; reason?: string };
    expect(output.allowed).toBe(false);
    expect(output.reason).toBe("backend denied");
  });

  test("returns allowed: true when backend also allows", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    const grantResult = await manager.grant(agentId("owner"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
    });
    expect(grantResult.ok).toBe(true);
    if (!grantResult.ok) return;

    const backend: PermissionBackend = {
      check: async () => ({ effect: "allow" as const }),
    };

    const tool = createDelegationCheckTool(
      manager,
      backend,
      agentId("owner"),
      "delegation",
      DEFAULT_UNSANDBOXED_POLICY,
    );
    const result = await tool.execute({
      grantId: grantResult.value.id,
      permission: "read_file",
    });

    const output = result as { allowed: boolean; reason?: string };
    expect(output.allowed).toBe(true);
  });

  test("throws on missing grantId", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);
    const tool = createDelegationCheckTool(
      manager,
      undefined,
      agentId("owner"),
      "delegation",
      DEFAULT_UNSANDBOXED_POLICY,
    );

    await expect(tool.execute({ permission: "read_file" })).rejects.toThrow("grantId");
  });

  test("throws on missing permission", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);
    const tool = createDelegationCheckTool(
      manager,
      undefined,
      agentId("owner"),
      "delegation",
      DEFAULT_UNSANDBOXED_POLICY,
    );

    await expect(tool.execute({ grantId: "some-id" })).rejects.toThrow("permission");
  });
});
