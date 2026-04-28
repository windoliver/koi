/**
 * Spawn lifecycle integration tests.
 *
 * Tests grant→spawn→terminate→revoke path using real spawnChildAgent +
 * mock NexusDelegationApi + mock parent agent. No real Nexus required.
 */
import { describe, expect, mock, test } from "bun:test";
import type {
  Agent,
  DelegationComponent,
  EngineAdapter,
  EngineEvent,
  SubsystemToken,
} from "@koi/core";
import { agentId, DELEGATION } from "@koi/core";
import { createInMemorySpawnLedger, spawnChildAgent } from "@koi/engine";
import { DEFAULT_SPAWN_POLICY } from "@koi/engine-compose";
import { createInMemoryRegistry } from "@koi/engine-reconcile";
import type { NexusDelegationApi } from "../delegation-api.js";
import { createNexusDelegationBackend } from "../nexus-delegation-backend.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockAdapter(): EngineAdapter {
  return {
    engineId: "mock",
    capabilities: { text: true, images: false, files: false, audio: false },
    stream: () => ({
      [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
        // let justified: mutable iterator state, single-use
        let done = false;
        return {
          async next(): Promise<IteratorResult<EngineEvent>> {
            if (done) return { done: true, value: undefined };
            done = true;
            return {
              done: false,
              value: {
                kind: "done" as const,
                output: {
                  content: [],
                  stopReason: "completed",
                  metrics: {
                    totalTokens: 1,
                    inputTokens: 1,
                    outputTokens: 0,
                    turns: 1,
                    durationMs: 10,
                  },
                },
              },
            };
          },
        };
      },
    }),
  };
}

function makeMockApi(overrides?: Partial<NexusDelegationApi>): NexusDelegationApi {
  return {
    createDelegation: mock(async () => ({
      ok: true as const,
      value: {
        delegation_id: "del-spawn-1",
        worker_agent_id: "child-1",
        api_key: "child-api-key-xyz",
        mount_table: ["fs://workspace"],
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        delegation_mode: "copy",
        warmup_success: true,
      },
    })),
    revokeDelegation: mock(async () => ({ ok: true as const, value: undefined })),
    verifyChain: mock(async () => ({
      ok: true as const,
      value: { chain: [], total_depth: 0 },
    })),
    listDelegations: mock(async () => ({
      ok: true as const,
      value: { delegations: [], total: 0, limit: 50, offset: 0 },
    })),
    ...overrides,
  };
}

/** Build a minimal mock parent Agent with optional DELEGATION component. */
function mockParentAgent(delegation?: DelegationComponent): Agent {
  const comps = new Map<string, unknown>();
  if (delegation !== undefined) comps.set(DELEGATION as unknown as string, delegation);
  return {
    pid: { id: agentId("parent-1"), name: "parent", type: "copilot", depth: 0 },
    manifest: {
      name: "parent",
      version: "0.1.0",
      model: { name: "mock" },
      permissions: { allow: ["read_file"], deny: [] },
      delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
    },
    state: "running",
    component: <T>(tok: SubsystemToken<T>) => comps.get(tok as unknown as string) as T | undefined,
    has: (tok: SubsystemToken<unknown>) => comps.has(tok as unknown as string),
    hasAll: (...tokens: SubsystemToken<unknown>[]) =>
      tokens.every((t) => comps.has(t as unknown as string)),
    query: <T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> => {
      const result = new Map<SubsystemToken<T>, T>();
      for (const [key, value] of comps) {
        if (key.startsWith(prefix)) {
          result.set(key as unknown as SubsystemToken<T>, value as T);
        }
      }
      return result;
    },
    components: () => comps as ReadonlyMap<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("spawn lifecycle — Nexus delegation", () => {
  test("grant called on spawn, nexusApiKey present in result", async () => {
    const mockApi = makeMockApi();
    const delegation = createNexusDelegationBackend({
      api: mockApi,
      agentId: agentId("parent-1"),
    });
    const parent = mockParentAgent(delegation);
    const ledger = createInMemorySpawnLedger(10);

    const result = await spawnChildAgent({
      manifest: {
        name: "child",
        version: "0.1.0",
        model: { name: "mock" },
        permissions: { allow: ["read_file"], deny: [] },
        delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
      },
      parentAgent: parent,
      adapter: makeMockAdapter(),
      spawnLedger: ledger,
      spawnPolicy: DEFAULT_SPAWN_POLICY,
    });

    expect(mockApi.createDelegation).toHaveBeenCalledTimes(1);
    expect(result.nexusApiKey).toBe("child-api-key-xyz");
    expect(result.delegationId).toBeDefined();

    await result.runtime.dispose();
  });

  test("revoke called when child handle terminates", async () => {
    const mockApi = makeMockApi();
    const delegation = createNexusDelegationBackend({
      api: mockApi,
      agentId: agentId("parent-1"),
    });
    const parent = mockParentAgent(delegation);
    const registry = createInMemoryRegistry();
    const ledger = createInMemorySpawnLedger(10);

    const result = await spawnChildAgent({
      manifest: {
        name: "child",
        version: "0.1.0",
        model: { name: "mock" },
        permissions: { allow: ["read_file"] },
        delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
      },
      parentAgent: parent,
      adapter: makeMockAdapter(),
      spawnLedger: ledger,
      spawnPolicy: DEFAULT_SPAWN_POLICY,
      registry,
    });

    const childId = result.childPid.id;

    // Transition child to terminated. Child handle subscribes to registry events
    // and fires onEvent("terminated") which calls parentDel.revoke().
    registry.transition(childId, "terminated", 0, { kind: "completed" });

    // Wait for async event propagation + revoke
    await new Promise((r) => setTimeout(r, 100));

    expect(mockApi.revokeDelegation).toHaveBeenCalledTimes(1);

    await result.runtime.dispose();
    await registry[Symbol.asyncDispose]();
  });

  test("revoke fires even when child terminates with error reason", async () => {
    const mockApi = makeMockApi();
    const delegation = createNexusDelegationBackend({
      api: mockApi,
      agentId: agentId("parent-1"),
    });
    const parent = mockParentAgent(delegation);
    const registry = createInMemoryRegistry();
    const ledger = createInMemorySpawnLedger(10);

    const result = await spawnChildAgent({
      manifest: {
        name: "child",
        version: "0.1.0",
        model: { name: "mock" },
        permissions: { allow: ["read_file"] },
        delegation: { enabled: true, maxChainDepth: 3, defaultTtlMs: 3_600_000 },
      },
      parentAgent: parent,
      adapter: makeMockAdapter(),
      spawnLedger: ledger,
      spawnPolicy: DEFAULT_SPAWN_POLICY,
      registry,
    });

    registry.transition(result.childPid.id, "terminated", 0, {
      kind: "error",
      cause: new Error("crash"),
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(mockApi.revokeDelegation).toHaveBeenCalledTimes(1);

    await result.runtime.dispose();
    await registry[Symbol.asyncDispose]();
  });
});
