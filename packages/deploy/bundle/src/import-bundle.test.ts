/**
 * Unit tests for importBundle() — import pipeline.
 */

import { describe, expect, test } from "bun:test";
import type { AgentBundle, BrickArtifact, ForgeStore, ToolArtifact } from "@koi/core";
import { BUNDLE_FORMAT_VERSION, bundleId } from "@koi/core";
import { computeBrickId, computeContentHash } from "@koi/hash";

import { importBundle } from "./import-bundle.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestProvenance(): ToolArtifact["provenance"] {
  return {
    source: { origin: "forged", forgedBy: "test-agent" },
    buildDefinition: { buildType: "forge", externalParameters: {} },
    builder: { id: "test-builder" },
    metadata: {
      invocationId: "inv-1",
      startedAt: 1000,
      finishedAt: 2000,
      sessionId: "sess-1",
      agentId: "agent-1",
      depth: 0,
    },
    verification: {
      passed: true,
      finalTrustTier: "verified",
      totalDurationMs: 1000,
      stageResults: [],
    },
    classification: "public",
    contentMarkers: [],
    contentHash: "abc123",
  };
}

function createTestBrick(overrides?: { readonly implementation?: string }): ToolArtifact {
  const implementation = overrides?.implementation ?? "function hello() { return 'world'; }";
  const id = computeBrickId("tool", implementation);
  return {
    id,
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    scope: "agent",
    trustTier: "verified",
    lifecycle: "active",
    provenance: createTestProvenance(),
    version: "1.0.0",
    tags: ["test"],
    usageCount: 0,
    implementation,
    inputSchema: { type: "object" },
  };
}

function createTestStore(initialBricks?: readonly BrickArtifact[]): ForgeStore & {
  readonly getAll: () => readonly BrickArtifact[];
} {
  const map = new Map<string, BrickArtifact>();
  if (initialBricks) {
    for (const brick of initialBricks) {
      map.set(brick.id, brick);
    }
  }
  return {
    save: async (brick) => {
      map.set(brick.id, brick);
      return { ok: true, value: undefined };
    },
    load: async (id) => {
      const brick = map.get(id);
      if (brick === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Not found: ${id}`, retryable: false },
        };
      }
      return { ok: true, value: brick };
    },
    search: async () => ({ ok: true, value: [...map.values()] }),
    remove: async (id) => {
      map.delete(id);
      return { ok: true, value: undefined };
    },
    update: async () => ({ ok: true, value: undefined }),
    exists: async (id) => ({ ok: true, value: map.has(id) }),
    getAll: () => [...map.values()],
  };
}

function createTestBundle(bricks: readonly BrickArtifact[]): AgentBundle {
  const manifestYaml = "name: test-agent\nversion: 1.0";
  const sortedBrickIds = [...bricks.map((b) => b.id)].sort();
  const contentHash = computeContentHash({ manifest: manifestYaml, brickIds: sortedBrickIds });
  return {
    version: BUNDLE_FORMAT_VERSION,
    id: bundleId(`bundle:${contentHash}`),
    name: "test-bundle",
    description: "A test bundle",
    manifestYaml,
    bricks,
    contentHash,
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("importBundle", () => {
  test("imports all bricks and returns correct counts", async () => {
    const brick1 = createTestBrick({ implementation: "function a() {}" });
    const brick2 = createTestBrick({ implementation: "function b() {}" });
    const bundle = createTestBundle([brick1, brick2]);
    const store = createTestStore();

    const result = await importBundle({ bundle, store });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.imported).toBe(2);
    expect(result.value.skipped).toBe(0);
    expect(result.value.errors).toHaveLength(0);
  });

  test("skips all when all bricks already exist", async () => {
    const brick = createTestBrick();
    const bundle = createTestBundle([brick]);
    const store = createTestStore([brick]);

    const result = await importBundle({ bundle, store });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.imported).toBe(0);
    expect(result.value.skipped).toBe(1);
    expect(result.value.errors).toHaveLength(0);
  });

  test("handles mix of existing and new bricks", async () => {
    const existing = createTestBrick({ implementation: "function existing() {}" });
    const newBrick = createTestBrick({ implementation: "function brand_new() {}" });
    const bundle = createTestBundle([existing, newBrick]);
    const store = createTestStore([existing]);

    const result = await importBundle({ bundle, store });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.imported).toBe(1);
    expect(result.value.skipped).toBe(1);
    expect(result.value.errors).toHaveLength(0);
  });

  test("reports error for corrupted brick (hash mismatch)", async () => {
    const brick = createTestBrick();
    // Corrupt the brick by changing its ID while keeping content the same
    const corruptedBrick: ToolArtifact = {
      ...brick,
      id: computeBrickId("tool", "totally-different-content"),
    };
    const bundle = createTestBundle([corruptedBrick]);
    const store = createTestStore();

    const result = await importBundle({ bundle, store });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.errors).toHaveLength(1);
    expect(result.value.errors[0]?.reason).toContain("Integrity check failed");
  });

  test("returns VALIDATION error for wrong bundle version", async () => {
    const brick = createTestBrick();
    const bundle = {
      ...createTestBundle([brick]),
      version: "99" as typeof BUNDLE_FORMAT_VERSION,
    };
    const store = createTestStore();

    const result = await importBundle({ bundle, store });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("version");
  });

  test("downgrades trust tier to sandbox for imported bricks", async () => {
    const brick = createTestBrick();
    const bundle = createTestBundle([brick]);
    const store = createTestStore();

    const result = await importBundle({ bundle, store });
    expect(result.ok).toBe(true);

    const loadResult = await store.load(brick.id);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;
    expect(loadResult.value.trustTier).toBe("sandbox");
  });

  test("sets provenance source to bundled origin", async () => {
    const brick = createTestBrick();
    const bundle = createTestBundle([brick]);
    const store = createTestStore();

    await importBundle({ bundle, store });

    const loadResult = await store.load(brick.id);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;
    expect(loadResult.value.provenance.source).toEqual({
      origin: "bundled",
      bundleName: "test-bundle",
      bundleVersion: BUNDLE_FORMAT_VERSION,
    });
  });

  test("returns VALIDATION error when content hash is tampered", async () => {
    const brick = createTestBrick();
    const bundle: AgentBundle = {
      ...createTestBundle([brick]),
      contentHash: "tampered-hash-value",
    };
    const store = createTestStore();

    const result = await importBundle({ bundle, store });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("content hash mismatch");
  });

  test("succeeds with empty bricks array", async () => {
    const bundle = createTestBundle([]);
    const store = createTestStore();

    const result = await importBundle({ bundle, store });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.imported).toBe(0);
    expect(result.value.skipped).toBe(0);
    expect(result.value.errors).toHaveLength(0);
  });
});
