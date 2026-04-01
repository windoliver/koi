import { describe, expect, mock, test } from "bun:test";
import type { Agent, AgentId, AttachResult } from "@koi/core";
import { DELEGATION, isAttachResult } from "@koi/core";
import type { DelegationManager } from "./delegation-manager.js";
import { createDelegationProvider } from "./delegation-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStubAgent(): Agent {
  return {
    pid: {
      id: "agent-1" as AgentId,
      name: "test-agent",
      type: "assistant",
      depth: 0,
    },
  } as unknown as Agent;
}

function createStubManager(): DelegationManager {
  return {
    grant: mock(() => {
      throw new Error("unexpected call");
    }),
    revoke: mock(() => {
      throw new Error("unexpected call");
    }),
    verify: mock(() => {
      throw new Error("unexpected call");
    }),
    list: mock(() => {
      throw new Error("unexpected call");
    }),
  } as unknown as DelegationManager;
}

/** Extract the components map from an attach result (handles both legacy and AttachResult). */
function toMap(result: AttachResult | ReadonlyMap<string, unknown>): ReadonlyMap<string, unknown> {
  if (isAttachResult(result)) {
    return result.components;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDelegationProvider", () => {
  test("enabled: false returns empty component map", async () => {
    const provider = createDelegationProvider({
      manager: createStubManager(),
      enabled: false,
    });

    expect(provider.name).toBe("delegation-tools");

    const raw = await provider.attach(createStubAgent());
    const components = toMap(raw);
    expect(components.size).toBe(0);
  });

  test("enabled: true (default) returns tools and DELEGATION component", async () => {
    const manager = createStubManager();
    const provider = createDelegationProvider({ manager });

    const raw = await provider.attach(createStubAgent());
    const components = toMap(raw);

    // Should have tools (grant, revoke, list, check) + DELEGATION component
    expect(components.size).toBeGreaterThan(0);
    expect(components.has(DELEGATION as string)).toBe(true);

    // Verify tool keys follow the naming convention
    const toolKeys = [...components.keys()].filter((k) => k.startsWith("tool:"));
    expect(toolKeys.length).toBeGreaterThanOrEqual(4); // grant, revoke, list, check
  });

  test("enabled: true explicitly returns tools", async () => {
    const manager = createStubManager();
    const provider = createDelegationProvider({
      manager,
      enabled: true,
    });

    const raw = await provider.attach(createStubAgent());
    const components = toMap(raw);
    expect(components.size).toBeGreaterThan(0);
    expect(components.has(DELEGATION as string)).toBe(true);
  });

  test("subset of operations limits attached tools", async () => {
    const manager = createStubManager();
    const provider = createDelegationProvider({
      manager,
      operations: ["grant", "list"],
    });

    const raw = await provider.attach(createStubAgent());
    const components = toMap(raw);
    const toolKeys = [...components.keys()].filter((k) => k.startsWith("tool:"));

    // Only grant + list tools (no revoke, no check)
    expect(toolKeys.length).toBe(2);
    expect(toolKeys.some((k) => k.includes("grant"))).toBe(true);
    expect(toolKeys.some((k) => k.includes("list"))).toBe(true);
  });
});
