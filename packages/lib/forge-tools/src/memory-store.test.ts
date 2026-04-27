/**
 * Tests for the in-memory ForgeStore (Task 3 — basic CRUD only).
 *
 * Idempotency, content integrity, scope-update rejection, and
 * optimistic locking land in Tasks 4 and 5.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { BrickId, ForgeProvenance, ToolArtifact } from "@koi/core";
import { createInMemoryForgeStore } from "./memory-store.js";
import { computeIdentityBrickId } from "./shared.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface ToolBrickOverrides {
  readonly name?: string;
  readonly description?: string;
  readonly version?: string;
  readonly scope?: "agent" | "global";
  readonly ownerAgentId?: string;
  readonly implementation?: string;
  readonly tags?: readonly string[];
}

function makeToolBrick(overrides: ToolBrickOverrides = {}): ToolArtifact {
  const name = overrides.name ?? "add-numbers";
  const description = overrides.description ?? "Add two numbers and return the sum.";
  const version = overrides.version ?? "0.0.1";
  const scope = overrides.scope ?? "agent";
  const ownerAgentId = overrides.ownerAgentId ?? "agent-A";
  const implementation = overrides.implementation ?? "return a + b;";
  const inputSchema: Readonly<Record<string, unknown>> = { type: "object" };

  const id: BrickId = computeIdentityBrickId({
    kind: "tool",
    name,
    description,
    version,
    scope,
    ownerAgentId,
    content: { implementation, inputSchema },
  });

  const provenance: ForgeProvenance = {
    source: { origin: "forged", forgedBy: ownerAgentId },
    buildDefinition: { buildType: "test", externalParameters: {} },
    builder: { id: "test-builder" },
    metadata: {
      invocationId: "inv-1",
      startedAt: 0,
      finishedAt: 0,
      sessionId: "sess-1",
      agentId: ownerAgentId,
      depth: 0,
    },
    verification: { passed: true, sandbox: true, totalDurationMs: 0, stageResults: [] },
    classification: "internal",
    contentMarkers: [],
    contentHash: id,
  };

  return {
    kind: "tool",
    id,
    name,
    description,
    scope,
    origin: "forged",
    policy: { sandbox: true, capabilities: {} },
    lifecycle: "draft",
    provenance,
    version,
    tags: overrides.tags ?? [],
    usageCount: 0,
    implementation,
    inputSchema,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createInMemoryForgeStore — basic CRUD", () => {
  let store: ReturnType<typeof createInMemoryForgeStore>;

  beforeEach(() => {
    store = createInMemoryForgeStore();
  });

  test("save then load round-trips the artifact", async () => {
    const brick = makeToolBrick();
    const saveResult = await store.save(brick);
    expect(saveResult.ok).toBe(true);

    const loadResult = await store.load(brick.id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.id).toBe(brick.id);
      expect(loadResult.value.name).toBe(brick.name);
    }
  });

  test("load returns NOT_FOUND for unknown id", async () => {
    const phantom = computeIdentityBrickId({
      kind: "tool",
      name: "missing",
      description: "missing",
      version: "0",
      scope: "agent",
      ownerAgentId: "agent-X",
      content: {},
    });
    const result = await store.load(phantom);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("search filters by kind and scope", async () => {
    const agentBrick = makeToolBrick({ name: "tool-agent", scope: "agent" });
    const globalBrick = makeToolBrick({ name: "tool-global", scope: "global" });
    await store.save(agentBrick);
    await store.save(globalBrick);

    const result = await store.search({ kind: "tool", scope: "agent" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.id).toBe(agentBrick.id);
    }
  });

  test("search filters by createdBy (matches provenance.metadata.agentId)", async () => {
    const a = makeToolBrick({ name: "tool-A", ownerAgentId: "agent-A" });
    const b = makeToolBrick({ name: "tool-B", ownerAgentId: "agent-B" });
    await store.save(a);
    await store.save(b);

    const matching = await store.search({ createdBy: "agent-A" });
    expect(matching.ok).toBe(true);
    if (matching.ok) {
      expect(matching.value.length).toBe(1);
      expect(matching.value[0]?.id).toBe(a.id);
    }

    const empty = await store.search({ createdBy: "nobody" });
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.value.length).toBe(0);
    }
  });

  test("searchSummaries returns lightweight summaries", async () => {
    const brick = makeToolBrick({ tags: ["math"] });
    await store.save(brick);

    const result = await store.searchSummaries?.({ kind: "tool" });
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.value.length).toBe(1);
      const summary = result.value[0];
      expect(summary?.id).toBe(brick.id);
      expect(summary?.name).toBe(brick.name);
      expect(summary?.tags).toEqual(["math"]);
      // No heavy fields on summaries
      expect((summary as unknown as { implementation?: string }).implementation).toBeUndefined();
    }
  });

  test("remove deletes the brick; subsequent load returns NOT_FOUND", async () => {
    const brick = makeToolBrick();
    await store.save(brick);

    const removeResult = await store.remove(brick.id);
    expect(removeResult.ok).toBe(true);

    const loadResult = await store.load(brick.id);
    expect(loadResult.ok).toBe(false);
    if (!loadResult.ok) {
      expect(loadResult.error.code).toBe("NOT_FOUND");
    }
  });

  test("remove returns NOT_FOUND for unknown id", async () => {
    const phantom = computeIdentityBrickId({
      kind: "tool",
      name: "missing",
      description: "missing",
      version: "0",
      scope: "agent",
      ownerAgentId: "agent-X",
      content: {},
    });
    const result = await store.remove(phantom);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("exists tracks brick lifecycle", async () => {
    const brick = makeToolBrick();

    const before = await store.exists(brick.id);
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.value).toBe(false);

    await store.save(brick);
    const afterSave = await store.exists(brick.id);
    expect(afterSave.ok).toBe(true);
    if (afterSave.ok) expect(afterSave.value).toBe(true);

    await store.remove(brick.id);
    const afterRemove = await store.exists(brick.id);
    expect(afterRemove.ok).toBe(true);
    if (afterRemove.ok) expect(afterRemove.value).toBe(false);
  });

  test("update applies field changes and bumps storeVersion", async () => {
    const brick = makeToolBrick();
    await store.save(brick);

    const updateResult = await store.update(brick.id, { lifecycle: "active" });
    expect(updateResult.ok).toBe(true);

    const loaded = await store.load(brick.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.lifecycle).toBe("active");
      expect(loaded.value.storeVersion).toBe(2);
    }
  });

  test("update returns NOT_FOUND for unknown id", async () => {
    const phantom = computeIdentityBrickId({
      kind: "tool",
      name: "missing",
      description: "missing",
      version: "0",
      scope: "agent",
      ownerAgentId: "agent-X",
      content: {},
    });
    const result = await store.update(phantom, { lifecycle: "active" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});
