/**
 * Unit tests for registerBundledAgents.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentArtifact,
  BrickId,
  ForgeProvenance,
  ForgeStore,
  KoiError,
  Result,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { registerBundledAgents } from "./register-bundled-agents.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DEFAULT_PROVENANCE: ForgeProvenance = {
  source: { origin: "bundled", bundleName: "test", bundleVersion: "0.1.0" },
  buildDefinition: { buildType: "test", externalParameters: {} },
  builder: { id: "test" },
  metadata: {
    invocationId: "",
    startedAt: 0,
    finishedAt: 0,
    sessionId: "",
    agentId: "",
    depth: 0,
  },
  verification: {
    passed: true,
    sandbox: false,
    totalDurationMs: 0,
    stageResults: [],
  },
  classification: "public",
  contentMarkers: [],
  contentHash: "abc",
};

function createTestAgent(name: string, id?: string): AgentArtifact {
  return {
    id: (id ?? `sha256:agent-${name}`) as BrickId,
    kind: "agent",
    name,
    description: `Test agent ${name}`,
    scope: "global",
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    lifecycle: "active",
    version: "0.1.0",
    tags: [],
    usageCount: 0,
    provenance: DEFAULT_PROVENANCE,
    manifestYaml: `name: ${name}\nmodel: test`,
  };
}

function createMockStore(existingIds: ReadonlySet<string> = new Set()): ForgeStore {
  const saved = new Map<string, AgentArtifact>();
  return {
    save: mock(async (brick: AgentArtifact): Promise<Result<void, KoiError>> => {
      saved.set(brick.id, brick);
      return { ok: true, value: undefined };
    }),
    exists: mock(async (id: string): Promise<Result<boolean, KoiError>> => {
      return { ok: true, value: existingIds.has(id) };
    }),
    search: mock(
      async () => ({ ok: true, value: [] }) as Result<readonly AgentArtifact[], KoiError>,
    ),
    load: mock(async () => ({
      ok: false,
      error: { code: "NOT_FOUND" as const, message: "not found", retryable: false },
    })),
    remove: mock(async () => ({ ok: true, value: undefined })),
    update: mock(async () => ({ ok: true, value: undefined })),
  } as unknown as ForgeStore;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerBundledAgents", () => {
  test("registers new agents to ForgeStore", async () => {
    const store = createMockStore();
    const agents = [createTestAgent("worker-a"), createTestAgent("worker-b")];

    const result = await registerBundledAgents(agents, store);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.registered).toBe(2);
      expect(result.value.skipped).toBe(0);
      expect(result.value.errors).toHaveLength(0);
    }
    expect(store.save).toHaveBeenCalledTimes(2);
  });

  test("skips existing agents (idempotent)", async () => {
    const existingIds = new Set(["sha256:agent-worker-a"]);
    const store = createMockStore(existingIds);
    const agents = [createTestAgent("worker-a"), createTestAgent("worker-b")];

    const result = await registerBundledAgents(agents, store);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.registered).toBe(1);
      expect(result.value.skipped).toBe(1);
      expect(result.value.errors).toHaveLength(0);
    }
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  test("collects save errors without throwing", async () => {
    const store = createMockStore();
    // Override save to fail
    (store.save as ReturnType<typeof mock>).mockImplementation(async () => ({
      ok: false,
      error: { code: "STORE" as const, message: "disk full", retryable: false },
    }));
    const agents = [createTestAgent("worker-a")];

    const result = await registerBundledAgents(agents, store);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.registered).toBe(0);
      expect(result.value.skipped).toBe(0);
      expect(result.value.errors).toHaveLength(1);
      expect(result.value.errors[0]).toContain("worker-a");
      expect(result.value.errors[0]).toContain("disk full");
    }
  });

  test("handles empty array", async () => {
    const store = createMockStore();
    const result = await registerBundledAgents([], store);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.registered).toBe(0);
      expect(result.value.skipped).toBe(0);
      expect(result.value.errors).toHaveLength(0);
    }
    expect(store.save).not.toHaveBeenCalled();
    expect(store.exists).not.toHaveBeenCalled();
  });
});
