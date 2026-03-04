import { describe, expect, mock, test } from "bun:test";
import type {
  Agent,
  AgentManifest,
  BrickArtifact,
  BrickId,
  CollectiveMemory,
  ForgeStore,
  ProcessId,
  SubsystemToken,
} from "@koi/core";
import { token } from "@koi/core";
import type { CollectiveMemoryContextSource } from "../types.js";
import {
  createCollectiveMemoryResolver,
  resolveCollectiveMemorySource,
} from "./collective-memory.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const FORGE_STORE_TOKEN = token<ForgeStore>("forge-store");

function createMockStore(brick?: Partial<BrickArtifact>): ForgeStore {
  const stored: BrickArtifact = {
    id: "sha256:abc123" as BrickId,
    kind: "agent",
    name: "researcher",
    description: "Research agent",
    scope: "session",
    trustTier: "verified",
    lifecycle: "active",
    provenance: {} as BrickArtifact["provenance"],
    version: "1.0.0",
    tags: [],
    usageCount: 0,
    manifestYaml: "name: researcher",
    ...brick,
  } as BrickArtifact;

  return {
    save: mock(async () => ({ ok: true as const, value: undefined })),
    load: mock(async () => ({ ok: true as const, value: stored })),
    search: mock(async () => ({ ok: true as const, value: [] as readonly BrickArtifact[] })),
    remove: mock(async () => ({ ok: true as const, value: undefined })),
    update: mock(async () => ({ ok: true as const, value: undefined })),
    exists: mock(async () => ({ ok: true as const, value: true })),
  } as unknown as ForgeStore;
}

function createMockAgent(forgeStore?: ForgeStore): Agent {
  const components = new Map<string, unknown>();
  if (forgeStore !== undefined) {
    components.set(FORGE_STORE_TOKEN as unknown as string, forgeStore);
  }

  return {
    pid: "pid-1" as unknown as ProcessId,
    manifest: { name: "researcher" } as AgentManifest,
    state: "running",
    component: <T>(t: SubsystemToken<T>) => components.get(t as unknown as string) as T | undefined,
    has: (t: SubsystemToken<unknown>) => components.has(t as unknown as string),
    hasAll: (...tokens: readonly SubsystemToken<unknown>[]) =>
      tokens.every((t) => components.has(t as unknown as string)),
    query: () => new Map(),
    components: () => components as ReadonlyMap<string, unknown>,
  };
}

const MEMORY_WITH_ENTRIES: CollectiveMemory = {
  entries: [
    {
      id: "e1",
      content: "Always use --frozen-lockfile in CI",
      category: "gotcha",
      source: { agentId: "agent-1", runId: "run-1", timestamp: NOW },
      createdAt: NOW,
      accessCount: 3,
      lastAccessedAt: NOW,
    },
    {
      id: "e2",
      content: "Exponential backoff with jitter works best",
      category: "pattern",
      source: { agentId: "agent-1", runId: "run-2", timestamp: NOW },
      createdAt: NOW,
      accessCount: 1,
      lastAccessedAt: NOW,
    },
  ],
  totalTokens: 50,
  generation: 2,
};

// ---------------------------------------------------------------------------
// resolveCollectiveMemorySource (built-in)
// ---------------------------------------------------------------------------

describe("resolveCollectiveMemorySource", () => {
  test("formats entries from brick's collective memory", async () => {
    const store = createMockStore({ collectiveMemory: MEMORY_WITH_ENTRIES });
    const agent = createMockAgent(store);
    const source: CollectiveMemoryContextSource = { kind: "collective_memory" };

    const result = await resolveCollectiveMemorySource(source, agent);

    expect(result.label).toBe("Collective Memory");
    expect(result.content).toContain("Always use --frozen-lockfile in CI");
    expect(result.content).toContain("Exponential backoff");
    expect(result.tokens).toBe(0); // hydrator estimates
  });

  test("uses custom label when provided", async () => {
    const store = createMockStore({ collectiveMemory: MEMORY_WITH_ENTRIES });
    const agent = createMockAgent(store);
    const source: CollectiveMemoryContextSource = {
      kind: "collective_memory",
      label: "Team Learnings",
    };

    const result = await resolveCollectiveMemorySource(source, agent);
    expect(result.label).toBe("Team Learnings");
  });

  test("returns empty content when brick has no collective memory", async () => {
    const store = createMockStore(); // no collectiveMemory
    const agent = createMockAgent(store);
    const source: CollectiveMemoryContextSource = { kind: "collective_memory" };

    const result = await resolveCollectiveMemorySource(source, agent);
    expect(result.content).toBe("");
  });

  test("returns empty content when brick load fails", async () => {
    const store = createMockStore();
    (store.load as ReturnType<typeof mock>).mockImplementation(async () => ({
      ok: false as const,
      error: { code: "NOT_FOUND", message: "Not found", retryable: false },
    }));
    const agent = createMockAgent(store);
    const source: CollectiveMemoryContextSource = { kind: "collective_memory" };

    const result = await resolveCollectiveMemorySource(source, agent);
    expect(result.content).toBe("");
  });

  test("throws when agent has no ForgeStore component", async () => {
    const agent = createMockAgent(); // no ForgeStore
    const source: CollectiveMemoryContextSource = { kind: "collective_memory" };

    await expect(resolveCollectiveMemorySource(source, agent)).rejects.toThrow(
      "Agent has no ForgeStore component attached",
    );
  });

  test("uses brickId override when provided", async () => {
    const store = createMockStore({ collectiveMemory: MEMORY_WITH_ENTRIES });
    const agent = createMockAgent(store);
    const source: CollectiveMemoryContextSource = {
      kind: "collective_memory",
      brickId: "sha256:custom",
    };

    await resolveCollectiveMemorySource(source, agent);
    expect(store.load).toHaveBeenCalledWith("sha256:custom");
  });
});

// ---------------------------------------------------------------------------
// createCollectiveMemoryResolver (factory)
// ---------------------------------------------------------------------------

describe("createCollectiveMemoryResolver", () => {
  test("creates a resolver that uses the provided ForgeStore", async () => {
    const store = createMockStore({ collectiveMemory: MEMORY_WITH_ENTRIES });
    const resolver = createCollectiveMemoryResolver(store);
    const agent = createMockAgent(); // no ForgeStore needed on agent

    const source: CollectiveMemoryContextSource = { kind: "collective_memory" };
    const result = await resolver(source, agent);

    expect(result.content).toContain("Always use --frozen-lockfile in CI");
  });

  test("returns empty content when no entries", async () => {
    const store = createMockStore(); // no collectiveMemory
    const resolver = createCollectiveMemoryResolver(store);
    const agent = createMockAgent();

    const source: CollectiveMemoryContextSource = { kind: "collective_memory" };
    const result = await resolver(source, agent);
    expect(result.content).toBe("");
  });
});
