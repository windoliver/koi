/**
 * Integration test — full export → serialize → deserialize → import pipeline.
 *
 * Verifies the complete roundtrip including dedup, trust downgrade, and
 * provenance rewriting.
 */

import { describe, expect, test } from "bun:test";
import type { BrickArtifact, ForgeStore, ToolArtifact } from "@koi/core";
import { BUNDLE_FORMAT_VERSION, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { computeBrickId } from "@koi/hash";

import { createBundle } from "../export-bundle.js";
import { importBundle } from "../import-bundle.js";
import { deserializeBundle, serializeBundle } from "../serialize.js";

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
      sandbox: false,
      totalDurationMs: 1000,
      stageResults: [],
    },
    classification: "public",
    contentMarkers: [],
    contentHash: "abc123",
  };
}

function createTestBrick(implementation: string): ToolArtifact {
  const id = computeBrickId("tool", implementation);
  return {
    id,
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    scope: "agent",
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    lifecycle: "active",
    provenance: createTestProvenance(),
    version: "1.0.0",
    tags: ["test"],
    usageCount: 0,
    implementation,
    inputSchema: { type: "object" },
  };
}

function createInMemoryStore(initialBricks?: readonly BrickArtifact[]): ForgeStore & {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("export → serialize → deserialize → import roundtrip", () => {
  test("full pipeline preserves all brick content", async () => {
    // 1. Create test bricks and save to store A
    const brick1 = createTestBrick("function greet() { return 'hello'; }");
    const brick2 = createTestBrick("function farewell() { return 'goodbye'; }");
    const storeA = createInMemoryStore([brick1, brick2]);

    // 2. Export from store A
    const exportResult = await createBundle({
      name: "roundtrip-test",
      description: "Integration test bundle",
      manifestYaml: "name: test-agent\nversion: 1.0",
      brickIds: [brick1.id, brick2.id],
      store: storeA,
    });
    expect(exportResult.ok).toBe(true);
    if (!exportResult.ok) return;

    // 3. Serialize to JSON
    const json = serializeBundle(exportResult.value);
    expect(json.length).toBeGreaterThan(0);

    // 4. Deserialize from JSON
    const deserializeResult = deserializeBundle(json);
    expect(deserializeResult.ok).toBe(true);
    if (!deserializeResult.ok) return;

    // 5. Import into store B
    const storeB = createInMemoryStore();
    const importResult = await importBundle({
      bundle: deserializeResult.value,
      store: storeB,
    });
    expect(importResult.ok).toBe(true);
    if (!importResult.ok) return;
    expect(importResult.value.imported).toBe(2);
    expect(importResult.value.skipped).toBe(0);
    expect(importResult.value.errors).toHaveLength(0);

    // 6. Verify bricks in store B match store A content
    const loadResult1 = await storeB.load(brick1.id);
    const loadResult2 = await storeB.load(brick2.id);
    expect(loadResult1.ok).toBe(true);
    expect(loadResult2.ok).toBe(true);
    if (!loadResult1.ok || !loadResult2.ok) return;

    expect((loadResult1.value as ToolArtifact).implementation).toBe(
      "function greet() { return 'hello'; }",
    );
    expect((loadResult2.value as ToolArtifact).implementation).toBe(
      "function farewell() { return 'goodbye'; }",
    );

    // 7. Verify trust tier is sandbox in store B
    expect(loadResult1.value.policy.sandbox).toBe(true);
    expect(loadResult2.value.policy.sandbox).toBe(true);

    // 8. Verify provenance source is bundled in store B
    expect(loadResult1.value.provenance.source).toEqual({
      origin: "bundled",
      bundleName: "roundtrip-test",
      bundleVersion: BUNDLE_FORMAT_VERSION,
    });
    expect(loadResult2.value.provenance.source).toEqual({
      origin: "bundled",
      bundleName: "roundtrip-test",
      bundleVersion: BUNDLE_FORMAT_VERSION,
    });

    // 9. Second import → all skipped (dedup)
    const reimportResult = await importBundle({
      bundle: deserializeResult.value,
      store: storeB,
    });
    expect(reimportResult.ok).toBe(true);
    if (!reimportResult.ok) return;
    expect(reimportResult.value.imported).toBe(0);
    expect(reimportResult.value.skipped).toBe(2);
    expect(reimportResult.value.errors).toHaveLength(0);
  });
});
