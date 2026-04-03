import { describe, expect, test } from "bun:test";
import type {
  BrickArtifact,
  BrickKind,
  BrickRegistryReader,
  BrickSearchQuery,
  ForgeStore,
  KoiError,
  Result,
} from "@koi/core";
import { checkBrickDependencies } from "./dependency-check.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockBrick(overrides?: Partial<BrickArtifact>): BrickArtifact {
  return {
    id: "sha256:abc123" as BrickArtifact["id"],
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    scope: "session",
    origin: { type: "forged" },
    policy: { autoApprove: true },
    lifecycle: "active",
    provenance: {
      source: { origin: "forged", forgedBy: "agent-1", sessionId: "s1" },
      buildDefinition: { buildType: "koi.forge/tool/v1", externalParameters: {} },
      builder: { id: "koi.forge/pipeline/v1" },
      metadata: {
        invocationId: "inv-1",
        startedAt: 1000,
        finishedAt: 2000,
        sessionId: "s1",
        agentId: "agent-1",
        depth: 0,
      },
      verification: {
        passed: true,
        sandbox: true,
        totalDurationMs: 100,
        stageResults: [],
      },
      classification: "public",
      contentMarkers: [],
      contentHash: "abc123",
    },
    version: "1.0.0",
    tags: ["test"],
    usageCount: 0,
    implementation: "function test() {}",
    inputSchema: {},
    ...overrides,
  } as BrickArtifact;
}

/**
 * Create a mock ForgeStore that returns specified bricks from search().
 */
function createMockStore(bricks: readonly BrickArtifact[] = []): ForgeStore {
  return {
    save: async () => ({ ok: true, value: undefined }),
    load: async () => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "Not found", retryable: false } as KoiError,
    }),
    search: async (query) => {
      const matching = bricks.filter((b) => {
        if (query.kind !== undefined && b.kind !== query.kind) return false;
        if (query.text !== undefined && !b.name.includes(query.text)) return false;
        return true;
      });
      return { ok: true, value: matching };
    },
    remove: async () => ({ ok: true, value: undefined }),
    update: async () => ({ ok: true, value: undefined }),
    exists: async () => ({ ok: true, value: false }),
  };
}

/**
 * Create a mock BrickRegistryReader that returns specified bricks from get().
 */
function createMockRemoteRegistry(
  bricks: ReadonlyMap<string, BrickArtifact> = new Map(),
): BrickRegistryReader {
  return {
    search: async (_query: BrickSearchQuery) => ({ items: [], total: 0 }),
    get: async (_kind: BrickKind, name: string): Promise<Result<BrickArtifact, KoiError>> => {
      const found = bricks.get(name);
      if (found !== undefined) {
        return { ok: true, value: found };
      }
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: `Brick "${name}" not found`, retryable: false },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkBrickDependencies", () => {
  test("no requires returns satisfied", async () => {
    const brick = createMockBrick();
    // Remove requires entirely — the mock brick has no requires by default
    const store = createMockStore();

    const result = await checkBrickDependencies(brick, store);

    expect(result.satisfied).toBe(true);
  });

  test("empty requires returns satisfied", async () => {
    const brick = createMockBrick({ requires: {} });
    const store = createMockStore();

    const result = await checkBrickDependencies(brick, store);

    expect(result.satisfied).toBe(true);
  });

  test("all tools available locally returns satisfied", async () => {
    const depTool = createMockBrick({ kind: "tool", name: "dep-tool" });
    const brick = createMockBrick({
      requires: { tools: ["dep-tool"] },
    });
    const store = createMockStore([depTool]);

    const result = await checkBrickDependencies(brick, store);

    expect(result.satisfied).toBe(true);
  });

  test("missing tool locally but available remotely", async () => {
    const remoteBrick = createMockBrick({ kind: "tool", name: "remote-tool" });
    const brick = createMockBrick({
      requires: { tools: ["remote-tool"] },
    });
    const store = createMockStore([]);
    const remote = createMockRemoteRegistry(new Map([["remote-tool", remoteBrick]]));

    const result = await checkBrickDependencies(brick, store, remote);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0]?.kind).toBe("tool");
      expect(result.missing[0]?.name).toBe("remote-tool");
      expect(result.missing[0]?.availableRemotely).toBe(true);
    }
  });

  test("missing tool not available anywhere", async () => {
    const brick = createMockBrick({
      requires: { tools: ["nonexistent-tool"] },
    });
    const store = createMockStore([]);
    const remote = createMockRemoteRegistry(new Map());

    const result = await checkBrickDependencies(brick, store, remote);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0]?.name).toBe("nonexistent-tool");
      expect(result.missing[0]?.availableRemotely).toBe(false);
    }
  });

  test("missing agent locally but available remotely", async () => {
    const remoteAgent = createMockBrick({
      kind: "agent",
      name: "helper-agent",
    } as Partial<BrickArtifact>);
    const brick = createMockBrick({
      requires: { agents: ["helper-agent"] },
    });
    const store = createMockStore([]);
    const remote = createMockRemoteRegistry(new Map([["helper-agent", remoteAgent]]));

    const result = await checkBrickDependencies(brick, store, remote);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0]?.kind).toBe("agent");
      expect(result.missing[0]?.availableRemotely).toBe(true);
    }
  });

  test("missing env var returns unsatisfied", async () => {
    // Use a guaranteed-nonexistent env var
    const envVar = `__KOI_TEST_NONEXISTENT_${Date.now()}__`;
    const brick = createMockBrick({
      requires: { env: [envVar] },
    });
    const store = createMockStore();

    const result = await checkBrickDependencies(brick, store);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0]?.kind).toBe("env");
      expect(result.missing[0]?.name).toBe(envVar);
      expect(result.missing[0]?.availableRemotely).toBe(false);
    }
  });

  test("missing bin returns unsatisfied", async () => {
    const brick = createMockBrick({
      requires: { bins: ["__koi_nonexistent_binary_12345__"] },
    });
    const store = createMockStore();

    const result = await checkBrickDependencies(brick, store);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing).toHaveLength(1);
      expect(result.missing[0]?.kind).toBe("bin");
      expect(result.missing[0]?.availableRemotely).toBe(false);
    }
  });

  test("multiple missing deps reported together", async () => {
    const envVar = `__KOI_TEST_NONEXISTENT_${Date.now()}__`;
    const brick = createMockBrick({
      requires: {
        tools: ["missing-tool"],
        env: [envVar],
        bins: ["__koi_nonexistent_binary__"],
      },
    });
    const store = createMockStore([]);

    const result = await checkBrickDependencies(brick, store);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing.length).toBeGreaterThanOrEqual(3);
      const kinds = result.missing.map((m) => m.kind);
      expect(kinds).toContain("tool");
      expect(kinds).toContain("env");
      expect(kinds).toContain("bin");
    }
  });

  test("without remote registry, missing tools report availableRemotely false", async () => {
    const brick = createMockBrick({
      requires: { tools: ["some-tool"] },
    });
    const store = createMockStore([]);

    // No remote registry provided
    const result = await checkBrickDependencies(brick, store);

    expect(result.satisfied).toBe(false);
    if (!result.satisfied) {
      expect(result.missing[0]?.availableRemotely).toBe(false);
    }
  });
});
