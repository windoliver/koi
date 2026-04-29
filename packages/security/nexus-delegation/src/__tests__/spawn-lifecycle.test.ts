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

  test("registry-path runtime.dispose() awaits bounded revoke before resolving", async () => {
    // Gated revoke: holds DELETE in-flight until we release. Verifies that
    // calling wrappedRuntime.dispose() in the registry-backed path does NOT
    // resolve until the per-child Nexus key revoke has completed (or timed
    // out). Without the dispose-wrapping, host teardown could complete with
    // the key still active server-side.
    let releaseRevoke: (() => void) | undefined;
    const revokeGate = new Promise<void>((resolve) => {
      releaseRevoke = resolve;
    });
    const mockApi = makeMockApi({
      revokeDelegation: mock(async () => {
        await revokeGate;
        return { ok: true as const, value: undefined };
      }),
    });
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

    // Track resolution timing to assert dispose() blocks on revokeGate.
    // let justified: mutable flag flipped by dispose continuation
    let disposeResolved = false;
    const disposePromise = result.runtime.dispose().then(() => {
      disposeResolved = true;
    });

    // Give the event loop several turns. Without the bounded-revoke await,
    // dispose() would resolve immediately because the underlying
    // childRuntime.dispose() has nothing to wait on.
    await new Promise((r) => setTimeout(r, 50));
    // sanity: revoke was invoked (gated, in-flight)
    expect(mockApi.revokeDelegation).toHaveBeenCalled();
    expect(disposeResolved).toBe(false);

    // Release the gate; dispose() must now resolve.
    releaseRevoke?.();
    await disposePromise;
    expect(disposeResolved).toBe(true);
    expect(mockApi.revokeDelegation).toHaveBeenCalledTimes(1);

    await registry[Symbol.asyncDispose]();
  });

  test("dispose() retries revoke after terminated-handler attempt failed", async () => {
    // First api.revokeDelegation call (from terminated handler) throws.
    // Backend wraps it as a queued retry and rejects the outer revoke().
    // The bounded-revoke memo must be CLEARED on rejection so that the
    // subsequent host-driven dispose() triggers a fresh attempt rather than
    // reusing the failed promise as a silent no-op.
    let revokeCallCount = 0;
    const errSpy = mock(() => {});
    const consoleErrorSpy = console.error;
    const consoleWarnSpy = console.warn;
    console.error = errSpy;
    console.warn = errSpy;

    const mockApi = makeMockApi({
      revokeDelegation: mock(async () => {
        revokeCallCount++;
        if (revokeCallCount === 1) {
          return {
            ok: false as const,
            error: {
              code: "INTERNAL" as const,
              message: "transient",
              retryable: true,
              context: {},
            },
          };
        }
        return { ok: true as const, value: undefined };
      }),
    });
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

    // Trigger terminated handler — first revoke attempt fails (transient).
    registry.transition(result.childPid.id, "terminated", 0, { kind: "completed" });
    await new Promise((r) => setTimeout(r, 50));
    expect(revokeCallCount).toBeGreaterThanOrEqual(1);

    // Host now calls dispose. Without memo-clear-on-failure, the cached
    // already-resolved (caught) promise would be reused and revoke would not
    // be retried, leaving the per-child key active. With the fix, dispose
    // triggers a fresh boundedRevokeOnce attempt that succeeds.
    const before = revokeCallCount;
    await result.runtime.dispose();
    expect(revokeCallCount).toBeGreaterThan(before);

    console.error = consoleErrorSpy;
    console.warn = consoleWarnSpy;
    await registry[Symbol.asyncDispose]();
  });
});
