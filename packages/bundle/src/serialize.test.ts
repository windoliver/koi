/**
 * Unit tests for serializeBundle() / deserializeBundle() — serialization pipeline.
 */

import { describe, expect, test } from "bun:test";
import type { AgentBundle, ToolArtifact } from "@koi/core";
import { BUNDLE_FORMAT_VERSION, bundleId } from "@koi/core";
import { computeBrickId, computeContentHash } from "@koi/hash";

import { deserializeBundle, serializeBundle } from "./serialize.js";

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

function createTestBrick(implementation?: string): ToolArtifact {
  const impl = implementation ?? "function hello() { return 'world'; }";
  const id = computeBrickId("tool", impl);
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
    implementation: impl,
    inputSchema: { type: "object" },
  };
}

function createTestBundle(bricks?: readonly ToolArtifact[]): AgentBundle {
  const manifestYaml = "name: test-agent\nversion: 1.0";
  const allBricks = bricks ?? [createTestBrick()];
  const sortedBrickIds = [...allBricks.map((b) => b.id)].sort();
  const contentHash = computeContentHash({ manifest: manifestYaml, brickIds: sortedBrickIds });
  return {
    version: BUNDLE_FORMAT_VERSION,
    id: bundleId(`bundle:${contentHash}`),
    name: "test-bundle",
    description: "A test bundle",
    manifestYaml,
    bricks: allBricks,
    contentHash,
    createdAt: 1700000000000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("serializeBundle / deserializeBundle", () => {
  test("roundtrip: serialize then deserialize produces identical bundle", () => {
    const bundle = createTestBundle();
    const json = serializeBundle(bundle);
    const result = deserializeBundle(json);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(bundle.version);
    expect(result.value.id).toBe(bundle.id);
    expect(result.value.name).toBe(bundle.name);
    expect(result.value.description).toBe(bundle.description);
    expect(result.value.manifestYaml).toBe(bundle.manifestYaml);
    expect(result.value.bricks).toHaveLength(bundle.bricks.length);
    expect(result.value.bricks[0]?.id).toBe(bundle.bricks[0]?.id);
    expect(result.value.contentHash).toBe(bundle.contentHash);
    expect(result.value.createdAt).toBe(bundle.createdAt);
  });

  test("returns VALIDATION error for invalid JSON string", () => {
    const result = deserializeBundle("{not valid json");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("Invalid JSON");
  });

  test("returns VALIDATION error for valid JSON missing required field", () => {
    const bundle = createTestBundle();
    const json = serializeBundle(bundle);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    delete parsed.name;
    const modifiedJson = JSON.stringify(parsed);

    const result = deserializeBundle(modifiedJson);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("name");
  });

  test("handles unicode content in brick implementations", () => {
    const brick = createTestBrick("function greet() { return '你好世界 🌍'; }");
    const bundle = createTestBundle([brick]);
    const json = serializeBundle(bundle);
    const result = deserializeBundle(json);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const importedBrick = result.value.bricks[0] as ToolArtifact;
    expect(importedBrick.implementation).toBe("function greet() { return '你好世界 🌍'; }");
  });

  test("returns VALIDATION error for empty string", () => {
    const result = deserializeBundle("");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("empty");
  });

  test("returns VALIDATION error for unsupported format version", () => {
    const bundle = createTestBundle();
    const json = serializeBundle(bundle);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    parsed.version = "99";
    const modifiedJson = JSON.stringify(parsed);

    const result = deserializeBundle(modifiedJson);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("version");
  });

  test("returns VALIDATION error for missing bricks array", () => {
    const bundle = createTestBundle();
    const json = serializeBundle(bundle);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    delete parsed.bricks;
    const modifiedJson = JSON.stringify(parsed);

    const result = deserializeBundle(modifiedJson);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("bricks");
  });

  test("preserves metadata through roundtrip", () => {
    const bundle: AgentBundle = {
      ...createTestBundle(),
      metadata: { author: "tester", tags: ["portable"] },
    };
    const json = serializeBundle(bundle);
    const result = deserializeBundle(json);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metadata).toEqual({ author: "tester", tags: ["portable"] });
  });
});
