/**
 * Unit tests for createBundle() — export pipeline.
 */

import { describe, expect, test } from "bun:test";
import type { BrickArtifact, ForgeStore, ToolArtifact } from "@koi/core";
import { computeBrickId } from "@koi/hash";

import { createBundle } from "./export-bundle.js";
import type { ExportBundleConfig } from "./types.js";

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

function createTestBrick(overrides?: {
  readonly implementation?: string;
  readonly files?: Readonly<Record<string, string>>;
}): ToolArtifact {
  const implementation = overrides?.implementation ?? "function hello() { return 'world'; }";
  const files = overrides?.files;
  const id = computeBrickId("tool", implementation, files);
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
    ...(files !== undefined ? { files } : {}),
  };
}

function createTestStore(bricks: readonly BrickArtifact[]): ForgeStore {
  const map = new Map<string, BrickArtifact>();
  for (const brick of bricks) {
    map.set(brick.id, brick);
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
  };
}

function makeConfig(overrides?: Partial<ExportBundleConfig>): ExportBundleConfig {
  const brick = createTestBrick();
  const store = createTestStore([brick]);
  return {
    name: "test-bundle",
    description: "A test bundle",
    manifestYaml: "name: test-agent\nversion: 1.0",
    brickIds: [brick.id],
    store,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createBundle", () => {
  test("creates bundle with correct fields", async () => {
    const brick = createTestBrick();
    const config = makeConfig({ brickIds: [brick.id], store: createTestStore([brick]) });

    const result = await createBundle(config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.version).toBe("1");
    expect(result.value.name).toBe("test-bundle");
    expect(result.value.description).toBe("A test bundle");
    expect(result.value.manifestYaml).toBe("name: test-agent\nversion: 1.0");
    expect(result.value.bricks).toHaveLength(1);
    expect(result.value.bricks[0]?.id).toBe(brick.id);
    expect(result.value.contentHash).toBeTruthy();
    expect(result.value.id).toContain("bundle:");
    expect(result.value.createdAt).toBeGreaterThan(0);
  });

  test("returns VALIDATION error for empty brick list", async () => {
    const config = makeConfig({ brickIds: [] });

    const result = await createBundle(config);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("brick ID");
  });

  test("returns VALIDATION error for empty name", async () => {
    const config = makeConfig({ name: "" });

    const result = await createBundle(config);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("name");
  });

  test("returns VALIDATION error for empty manifestYaml", async () => {
    const config = makeConfig({ manifestYaml: "" });

    const result = await createBundle(config);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("Manifest");
  });

  test("returns NOT_FOUND when brick not in store", async () => {
    const store = createTestStore([]);
    const config = makeConfig({
      brickIds: ["sha256:0000000000000000000000000000000000000000000000000000000000000000"],
      store,
    });

    const result = await createBundle(config);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("deduplicates brick IDs silently", async () => {
    const brick = createTestBrick();
    const store = createTestStore([brick]);
    const config = makeConfig({
      brickIds: [brick.id, brick.id, brick.id],
      store,
    });

    const result = await createBundle(config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bricks).toHaveLength(1);
  });

  test("includes brick companion files in bundle", async () => {
    const brick = createTestBrick({
      implementation: "function withFiles() {}",
      files: { "readme.md": "# Hello", "config.json": "{}" },
    });
    const store = createTestStore([brick]);
    const config = makeConfig({ brickIds: [brick.id], store });

    const result = await createBundle(config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bricks[0]?.files).toEqual({
      "readme.md": "# Hello",
      "config.json": "{}",
    });
  });

  test("content hash is deterministic", async () => {
    const brick = createTestBrick();
    const store = createTestStore([brick]);
    const config = makeConfig({ brickIds: [brick.id], store });

    const result1 = await createBundle(config);
    const result2 = await createBundle(config);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (!result1.ok || !result2.ok) return;
    expect(result1.value.contentHash).toBe(result2.value.contentHash);
  });

  test("bundle ID is derived from content hash", async () => {
    const brick = createTestBrick();
    const store = createTestStore([brick]);
    const config = makeConfig({ brickIds: [brick.id], store });

    const result = await createBundle(config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(String(result.value.id)).toBe(`bundle:${result.value.contentHash}`);
  });

  test("includes metadata when provided", async () => {
    const brick = createTestBrick();
    const store = createTestStore([brick]);
    const config = makeConfig({
      brickIds: [brick.id],
      store,
      metadata: { author: "tester", version: 2 },
    });

    const result = await createBundle(config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata).toEqual({ author: "tester", version: 2 });
  });
});
