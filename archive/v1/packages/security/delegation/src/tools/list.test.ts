import { afterEach, describe, expect, test } from "bun:test";
import {
  agentId,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_SANDBOXED_POLICY,
  DEFAULT_UNSANDBOXED_POLICY,
} from "@koi/core";
import { createDelegationManager } from "../delegation-manager.js";
import { createDelegationListTool } from "./list.js";

const SECRET = "test-secret-key-32-bytes-minimum";
const DEFAULT_CONFIG = {
  secret: SECRET,
  maxChainDepth: 3,
  defaultTtlMs: 3600000,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
} as const;

describe("createDelegationListTool", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  });

  test("descriptor has correct name and schema", () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);
    const tool = createDelegationListTool(
      manager,
      agentId("owner"),
      "delegation",
      DEFAULT_UNSANDBOXED_POLICY,
    );
    expect(tool.descriptor.name).toBe("delegation_list");
    expect(tool.policy.sandbox).toBe(false);
  });

  test("returns empty grants list when none exist", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);
    const tool = createDelegationListTool(
      manager,
      agentId("owner"),
      "delegation",
      DEFAULT_UNSANDBOXED_POLICY,
    );

    const result = await tool.execute({});
    const output = result as { grants: readonly unknown[] };
    expect(output.grants).toHaveLength(0);
  });

  test("returns grants for the owner agent", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    await manager.grant(agentId("owner"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
    });
    await manager.grant(agentId("owner"), agentId("agent-3"), {
      permissions: { allow: ["write_file"] },
    });

    const tool = createDelegationListTool(
      manager,
      agentId("owner"),
      "delegation",
      DEFAULT_UNSANDBOXED_POLICY,
    );
    const result = await tool.execute({});
    const output = result as {
      grants: readonly { id: string; delegateeId: string; scope: unknown }[];
    };

    expect(output.grants).toHaveLength(2);
    expect(output.grants[0]?.id).toBeDefined();
    expect(output.grants[0]?.delegateeId).toBe(agentId("agent-2"));
  });

  test("does not include grants from other agents", async () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);

    await manager.grant(agentId("other-agent"), agentId("agent-2"), {
      permissions: { allow: ["read_file"] },
    });

    const tool = createDelegationListTool(
      manager,
      agentId("owner"),
      "delegation",
      DEFAULT_UNSANDBOXED_POLICY,
    );
    const result = await tool.execute({});
    const output = result as { grants: readonly unknown[] };
    expect(output.grants).toHaveLength(0);
  });

  test("uses custom prefix", () => {
    const manager = createDelegationManager({ config: DEFAULT_CONFIG });
    cleanups.push(manager.dispose);
    const tool = createDelegationListTool(
      manager,
      agentId("owner"),
      "custom",
      DEFAULT_SANDBOXED_POLICY,
    );
    expect(tool.descriptor.name).toBe("custom_list");
  });
});
