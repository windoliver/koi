/**
 * Tests for the additionalTools ceiling guard (Issue 1 / Issue #1240).
 *
 * Verifies the security invariant: a parent agent cannot inject tools into a child
 * that the parent itself does not hold. This closes the privilege escalation path
 * where additionalTools could be used to bypass the capability ceiling.
 *
 * (Open Security Architecture SP-047: children can only receive a subset of
 * parent capabilities — never exceeding them through the delegation chain.)
 */

import { describe, expect, test } from "bun:test";
import type { Agent, AgentManifest, SubsystemToken, Tool } from "@koi/core";
import { agentId, DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { createAgentSpawnFn } from "../create-agent-spawn-fn.js";
import { createInMemorySpawnLedger } from "../spawn-ledger.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockTool(name: string): Tool {
  return {
    descriptor: { name, description: `Mock tool ${name}`, inputSchema: { type: "object" } },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async () => ({ result: name }),
  };
}

const BASE_MANIFEST: AgentManifest = {
  name: "parent",
  version: "0.1.0",
  model: { name: "test-model" },
};

/** Creates a mock parent Agent with the given registered tools. */
function mockParentAgent(registeredTools: readonly string[]): Agent {
  const toolMap = new Map<string, Tool>(
    registeredTools.map((name) => [`tool:${name}`, mockTool(name)]),
  );
  return {
    pid: { id: agentId("parent-001"), name: "parent", type: "copilot", depth: 0 },
    manifest: BASE_MANIFEST,
    state: "running",
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: <T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> => {
      if (prefix === "tool:") {
        return toolMap as unknown as ReadonlyMap<SubsystemToken<T>, T>;
      }
      return new Map();
    },
    components: () => toolMap as ReadonlyMap<string, unknown>,
  };
}

function makeSpawnFn(parentTools: readonly string[]) {
  const resolver = {
    resolve: () => ({
      ok: true as const,
      value: {
        name: "child-agent",
        description: "test child",
        manifest: {
          name: "child-agent",
          version: "0.1.0",
          model: { name: "test-model" },
        },
      },
    }),
    list: () => [],
  };

  const mockAdapter = {
    engineId: "test",
    capabilities: { text: true, images: false, files: false, audio: false },
    stream: () => {
      throw new Error("not used");
    },
  } as unknown as Parameters<typeof createAgentSpawnFn>[0]["adapter"];

  return createAgentSpawnFn({
    resolver,
    base: {
      parentAgent: mockParentAgent(parentTools),
      spawnLedger: createInMemorySpawnLedger(10),
      spawnPolicy: {
        maxTotalProcesses: 10,
        maxDepth: 5,
        maxFanOut: 5,
      },
    },
    adapter: mockAdapter,
    manifestTemplate: BASE_MANIFEST,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("additionalTools ceiling guard", () => {
  test("rejects additionalTools containing a tool not registered on parent", async () => {
    const spawnFn = makeSpawnFn(["Read", "Grep"]); // parent has Read and Grep
    const signal = AbortSignal.timeout(1000);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "test spawn",
      signal,
      additionalTools: [
        {
          name: "Write", // Write is NOT in parent's tool set
          description: "Write files",
          inputSchema: { type: "object" },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("Write");
      expect(result.error.message).toContain("parent cannot confer capabilities it does not hold");
      expect(result.error.retryable).toBe(false);
    }
  });

  test("accepts additionalTools when all tools are registered on parent", async () => {
    // When all additionalTools are parent-owned, the request should proceed past
    // the ceiling guard. It may still fail at spawn time if the engine is not wired,
    // but the PERMISSION error must NOT be returned.
    const spawnFn = makeSpawnFn(["Read", "Grep", "Write"]);
    const signal = AbortSignal.timeout(1000);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "test spawn",
      signal,
      additionalTools: [
        {
          name: "Read",
          description: "Read files",
          inputSchema: { type: "object" },
        },
      ],
    });

    // Must not be a PERMISSION error from the ceiling guard
    if (!result.ok) {
      expect(result.error.code).not.toBe("PERMISSION");
    }
    // (May be other errors from missing engine infrastructure — that is expected in unit tests)
  });

  test("accepts empty additionalTools array without error", async () => {
    const spawnFn = makeSpawnFn(["Read"]);
    const signal = AbortSignal.timeout(1000);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "test spawn",
      signal,
      additionalTools: [],
    });

    // Empty additionalTools is a no-op — ceiling guard should not reject
    if (!result.ok) {
      expect(result.error.code).not.toBe("PERMISSION");
    }
  });

  test("accepts spawn with no additionalTools field at all", async () => {
    const spawnFn = makeSpawnFn(["Read"]);
    const signal = AbortSignal.timeout(1000);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "test spawn with no additionalTools",
      signal,
      // additionalTools intentionally omitted
    });

    if (!result.ok) {
      expect(result.error.code).not.toBe("PERMISSION");
    }
  });

  test("rejects multiple unknown tools and names all of them in the error", async () => {
    const spawnFn = makeSpawnFn(["Read"]); // parent only has Read
    const signal = AbortSignal.timeout(1000);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "test spawn",
      signal,
      additionalTools: [
        { name: "Write", description: "Write files", inputSchema: { type: "object" } },
        { name: "Bash", description: "Run bash", inputSchema: { type: "object" } },
        { name: "Delete", description: "Delete files", inputSchema: { type: "object" } },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      // All unknown tool names must appear in the error message
      expect(result.error.message).toContain("Write");
      expect(result.error.message).toContain("Bash");
      expect(result.error.message).toContain("Delete");
    }
  });

  test("tool filtered by denylist is still considered 'held by parent' for additionalTools ceiling", async () => {
    // Semantic decision: the ceiling guard checks whether the parent HOLDS the tool,
    // not whether the parent PASSES it to the child. A tool blocked by the runtime
    // denylist is still registered on the parent — the parent chose to block it
    // for THIS child, but may legitimately inject it as an additionalTool for
    // structured output purposes (e.g., HookVerdict).
    //
    // This test documents that the ceiling check uses parent.query(), which returns
    // ALL parent tools regardless of the denylist applied to the current spawn.
    const spawnFn = makeSpawnFn(["Read", "HookVerdict"]);
    const signal = AbortSignal.timeout(1000);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "hook agent spawn",
      signal,
      toolDenylist: ["HookVerdict"], // block from general inheritance
      additionalTools: [
        {
          name: "HookVerdict", // but inject it explicitly as the structured output tool
          description: "Verdict tool for hook agent",
          inputSchema: { type: "object" },
        },
      ],
    });

    // Must NOT be a PERMISSION/ceiling error — HookVerdict IS registered on the parent
    if (!result.ok) {
      expect(result.error.code).not.toBe("PERMISSION");
    }
  });
});
