/**
 * spawn-fork-nested — regression test for Issue #1790.
 *
 * Verifies that fork children receive a fresh Spawn provider when all policy
 * conditions are met (manifest ceiling, depth guard, selfCeiling). Before the
 * fix, fork children silently lost the Spawn tool because `!isFork` blocked
 * fresh-provider creation — causing "simulation mode" where the model narrated
 * spawning without actually executing grandchild agents.
 *
 * The depth guard (maxDepth) in the spawn guard middleware is the correct
 * recursion bound for nested spawns. The fork inheritance guard (applyForkDenylist)
 * only prevents inheriting the parent's closure-bound Spawn tool.
 */

import { describe, expect, test } from "bun:test";
import type { Agent, AgentManifest, ComponentProvider, SubsystemToken, Tool } from "@koi/core";
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

function mockSpawnProviderFactory(): {
  readonly factory: () => ComponentProvider;
  readonly calls: number[];
} {
  const calls: number[] = [];
  const factory = (): ComponentProvider => {
    calls.push(Date.now());
    return {
      name: "mock-spawn-provider",
      attach: async () => new Map(),
    };
  };
  return { factory, calls };
}

function makeSpawnFn(
  parentTools: readonly string[],
  spawnProviderFactory?: () => ComponentProvider,
) {
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
    spawnProviderFactory,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fork children receive Spawn (Issue #1790)", () => {
  test("spawnProviderFactory is called for fork=true + allowNestedSpawn=true", async () => {
    const { factory, calls } = mockSpawnProviderFactory();
    const spawnFn = makeSpawnFn(["Read"], factory);
    const signal = AbortSignal.timeout(1000);

    // The spawn will likely fail downstream (no real engine wired), but the
    // provider factory MUST be called before that failure point.
    await spawnFn({
      agentName: "child-agent",
      description: "coordinator that will spawn grandchildren",
      signal,
      fork: true,
      allowNestedSpawn: true,
    });

    // The factory must have been invoked — fork+allowNestedSpawn children get a fresh Spawn provider
    expect(calls.length).toBe(1);
  });

  test("spawnProviderFactory is NOT called for fork=true without allowNestedSpawn (leaf worker)", async () => {
    const { factory, calls } = mockSpawnProviderFactory();
    const spawnFn = makeSpawnFn(["Read"], factory);
    const signal = AbortSignal.timeout(1000);

    await spawnFn({
      agentName: "child-agent",
      description: "leaf worker — cannot spawn",
      signal,
      fork: true,
    });

    // Default fork children are leaf workers — no Spawn provider
    expect(calls.length).toBe(0);
  });

  test("spawnProviderFactory is called for fork=false spawn (baseline)", async () => {
    const { factory, calls } = mockSpawnProviderFactory();
    const spawnFn = makeSpawnFn(["Read"], factory);
    const signal = AbortSignal.timeout(1000);

    await spawnFn({
      agentName: "child-agent",
      description: "regular child",
      signal,
      // fork omitted = non-fork spawn (fork field only accepts `true`)
    });

    expect(calls.length).toBe(1);
  });

  test("spawnProviderFactory is NOT called when parent manifest denylist blocks Spawn", async () => {
    // isSpawnAllowedByManifest checks base.parentAgent.manifest.spawn —
    // the PARENT's manifest controls whether children can receive Spawn.
    const { factory, calls } = mockSpawnProviderFactory();
    const parentWithSpawnDenied = mockParentAgent(["Read"]);
    // Patch the parent manifest to deny Spawn for children
    (parentWithSpawnDenied.manifest as AgentManifest) = {
      ...BASE_MANIFEST,
      spawn: {
        tools: { policy: "denylist", list: ["Spawn"] },
      },
    };

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

    const spawnFn = createAgentSpawnFn({
      resolver,
      base: {
        parentAgent: parentWithSpawnDenied,
        spawnLedger: createInMemorySpawnLedger(10),
        spawnPolicy: {
          maxTotalProcesses: 10,
          maxDepth: 5,
          maxFanOut: 5,
        },
      },
      adapter: mockAdapter,
      manifestTemplate: BASE_MANIFEST,
      spawnProviderFactory: factory,
    });

    const signal = AbortSignal.timeout(1000);
    await spawnFn({
      agentName: "child-agent",
      description: "child blocked by parent manifest",
      signal,
      fork: true,
      allowNestedSpawn: true, // opt-in, but manifest still blocks
    });

    // Factory must NOT be called when parent manifest blocks Spawn
    expect(calls.length).toBe(0);
  });

  test("spawnProviderFactory is NOT called when request toolDenylist includes Spawn", async () => {
    const { factory, calls } = mockSpawnProviderFactory();
    const spawnFn = makeSpawnFn(["Read"], factory);
    const signal = AbortSignal.timeout(1000);

    await spawnFn({
      agentName: "child-agent",
      description: "child with Spawn denied",
      signal,
      fork: true,
      allowNestedSpawn: true, // opt-in, but toolDenylist still blocks
      toolDenylist: ["Spawn"],
    });

    expect(calls.length).toBe(0);
  });

  test("spawnProviderFactory is NOT called when fork + toolAllowlist conflict (validation-first)", async () => {
    // fork + toolAllowlist is mutually exclusive — validateSpawnRequest rejects before
    // the provider factory is ever invoked (prevents resource leaks from invalid requests).
    const { factory, calls } = mockSpawnProviderFactory();
    const spawnFn = makeSpawnFn(["Read"], factory);
    const signal = AbortSignal.timeout(1000);

    const result = await spawnFn({
      agentName: "child-agent",
      description: "invalid: fork + toolAllowlist",
      signal,
      fork: true,
      toolAllowlist: ["Read", "Spawn"],
    });

    expect(result.ok).toBe(false);
    expect(calls.length).toBe(0); // factory never called for invalid requests
  });

  test("spawnProviderFactory is NOT called when request toolAllowlist omits Spawn", async () => {
    const { factory, calls } = mockSpawnProviderFactory();
    const spawnFn = makeSpawnFn(["Read"], factory);
    const signal = AbortSignal.timeout(1000);

    await spawnFn({
      agentName: "child-agent",
      description: "child with restricted allowlist",
      signal,
      fork: true,
      toolAllowlist: ["Read"],
    });

    expect(calls.length).toBe(0);
  });
});
