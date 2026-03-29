/**
 * Tests for forge_edit — edit existing forged brick via search-and-replace.
 */

import { describe, expect, mock, test } from "bun:test";
import type { BrickArtifact, BrickId, ForgeStore, KoiError, Result } from "@koi/core";
import { brickId } from "@koi/core";
import type { ForgePipeline } from "@koi/forge-types";
import { createDefaultForgeConfig } from "@koi/forge-types";
import {
  createTestAgentArtifact,
  createTestSkillArtifact,
  createTestToolArtifact,
} from "@koi/test-utils";
import { createForgeEditTool } from "./forge-edit.js";
import type { ForgeDeps } from "./shared.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT = {
  agentId: "agent-1",
  depth: 0,
  sessionId: "session-1",
  forgesThisSession: 0,
} as const;

function mockStore(bricks: readonly BrickArtifact[]): ForgeStore {
  const map = new Map<string, BrickArtifact>();
  for (const b of bricks) {
    map.set(b.id, b);
  }
  return {
    save: mock(async () => ({ ok: true as const, value: undefined })),
    load: mock(async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
      const b = map.get(id);
      if (b !== undefined) return { ok: true, value: b };
      return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
    }),
    search: mock(
      async (): Promise<Result<readonly BrickArtifact[], KoiError>> => ({
        ok: true,
        value: [...map.values()],
      }),
    ),
    remove: mock(async () => ({ ok: true as const, value: undefined })),
    update: mock(async () => ({ ok: true as const, value: undefined })),
    exists: mock(async () => ({ ok: true as const, value: false })),
  };
}

function mockPipeline(): ForgePipeline {
  return {
    verify: mock(async () => ({
      ok: true as const,
      value: { stages: [], sandbox: true, totalDurationMs: 0, passed: true },
    })),
    checkGovernance: mock(async () => ({ ok: true as const, value: undefined })),
    createProvenance: mock(
      () =>
        ({
          source: { origin: "forged" as const, forgedBy: "agent-1" },
          buildDefinition: { buildType: "test", externalParameters: {} },
          builder: { id: "test" },
          metadata: {
            invocationId: "test",
            startedAt: 0,
            finishedAt: 0,
            sessionId: "s",
            agentId: "a",
            depth: 0,
          },
          verification: { passed: true, sandbox: true, totalDurationMs: 0, stageResults: [] },
          classification: "public" as const,
          contentMarkers: [],
          contentHash: "test",
        }) satisfies ReturnType<ForgePipeline["createProvenance"]>,
    ),
    signAttestation: mock(
      async (p: unknown) => p as Awaited<ReturnType<ForgePipeline["signAttestation"]>>,
    ),
    extractBrickContent: mock(() => ({ kind: "tool" as const, content: "return 2;" })),
    checkMutationPressure: mock(async () => ({ ok: true as const, value: undefined })),
  } as unknown as ForgePipeline;
}

function makeDeps(overrides?: Partial<ForgeDeps>): ForgeDeps {
  const config = createDefaultForgeConfig();
  return {
    store: mockStore([]),
    executor: {
      execute: async () => ({ ok: true as const, value: { output: null, durationMs: 0 } }),
    },
    verifiers: [],
    config,
    context: DEFAULT_CONTEXT,
    pipeline: mockPipeline(),
    ...overrides,
  };
}

async function executeEdit(
  deps: ForgeDeps,
  input: unknown,
): Promise<
  Result<{ readonly id: BrickId; readonly strategy: string; readonly confidence: number }, unknown>
> {
  const tool = createForgeEditTool(deps);
  const result = await tool.execute(input as Record<string, unknown>);
  return result as Result<
    { readonly id: BrickId; readonly strategy: string; readonly confidence: number },
    unknown
  >;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("forge_edit — input validation", () => {
  test("rejects null input", async () => {
    const deps = makeDeps();
    const result = await executeEdit(deps, null);
    expect(result.ok).toBe(false);
  });

  test("rejects non-object input", async () => {
    const deps = makeDeps();
    const result = await executeEdit(deps, "not-an-object");
    expect(result.ok).toBe(false);
  });

  test("rejects missing brickId", async () => {
    const deps = makeDeps();
    const result = await executeEdit(deps, {
      searchBlock: "return 1;",
      replaceBlock: "return 2;",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects missing searchBlock", async () => {
    const deps = makeDeps();
    const result = await executeEdit(deps, {
      brickId: "test-id",
      replaceBlock: "return 2;",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects missing replaceBlock", async () => {
    const deps = makeDeps();
    const result = await executeEdit(deps, {
      brickId: "test-id",
      searchBlock: "return 1;",
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("forge_edit — happy path", () => {
  test("edits a tool brick and returns new ID", async () => {
    const tool = createTestToolArtifact({
      id: brickId("original-tool"),
      name: "my-tool",
      implementation: "return 1;",
    });
    const store = mockStore([tool]);
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, pipeline });

    const result = await executeEdit(deps, {
      brickId: "original-tool",
      searchBlock: "return 1;",
      replaceBlock: "return 2;",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // New brick has a different ID (content-addressed)
      expect(result.value.id).not.toBe("original-tool");
      expect(result.value.strategy).toBeDefined();
      expect(result.value.confidence).toBeGreaterThan(0);
    }
    // Store.save should have been called with the new brick
    expect(store.save).toHaveBeenCalled();
  });

  test("edits a skill brick", async () => {
    const skill = createTestSkillArtifact({
      id: brickId("original-skill"),
      name: "my-skill",
      content: "# Old Content\nSome text",
    });
    const store = mockStore([skill]);
    const pipeline = mockPipeline();
    (pipeline.extractBrickContent as ReturnType<typeof mock>).mockImplementation(() => ({
      kind: "skill",
      content: "# New Content\nSome text",
    }));
    const deps = makeDeps({ store, pipeline });

    const result = await executeEdit(deps, {
      brickId: "original-skill",
      searchBlock: "# Old Content",
      replaceBlock: "# New Content",
    });

    expect(result.ok).toBe(true);
  });

  test("accepts optional description parameter", async () => {
    const tool = createTestToolArtifact({
      id: brickId("desc-tool"),
      implementation: "return 1;",
    });
    const store = mockStore([tool]);
    const deps = makeDeps({ store });

    const result = await executeEdit(deps, {
      brickId: "desc-tool",
      searchBlock: "return 1;",
      replaceBlock: "return 2;",
      description: "Fix return value",
    });

    expect(result.ok).toBe(true);
  });

  test("increments version from parent brick", async () => {
    const tool = createTestToolArtifact({
      id: brickId("versioned-tool"),
      implementation: "return 1;",
      version: "0.0.3",
    });
    const store = mockStore([tool]);
    const deps = makeDeps({ store });

    await executeEdit(deps, {
      brickId: "versioned-tool",
      searchBlock: "return 1;",
      replaceBlock: "return 2;",
    });

    // Check the saved artifact has incremented version
    const saveCall = (store.save as ReturnType<typeof mock>).mock.calls[0];
    const savedBrick = saveCall?.[0] as BrickArtifact;
    expect(savedBrick.version).toBe("0.0.4");
  });

  test("saved brick has new provenance", async () => {
    const tool = createTestToolArtifact({
      id: brickId("prov-tool"),
      implementation: "return 1;",
    });
    const store = mockStore([tool]);
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, pipeline });

    await executeEdit(deps, {
      brickId: "prov-tool",
      searchBlock: "return 1;",
      replaceBlock: "return 2;",
    });

    expect(pipeline.createProvenance).toHaveBeenCalled();
    expect(pipeline.verify).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("forge_edit — error paths", () => {
  test("returns error when brick not found", async () => {
    const store = mockStore([]);
    const deps = makeDeps({ store });

    const result = await executeEdit(deps, {
      brickId: "nonexistent",
      searchBlock: "return 1;",
      replaceBlock: "return 2;",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as { code: string }).code).toBe("LOAD_FAILED");
    }
  });

  test("returns error for agent brick (not editable)", async () => {
    const agent = createTestAgentArtifact({
      id: brickId("agent-brick"),
    });
    const store = mockStore([agent]);
    const deps = makeDeps({ store });

    const result = await executeEdit(deps, {
      brickId: "agent-brick",
      searchBlock: "anything",
      replaceBlock: "new",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as { code: string }).code).toBe("INVALID_TYPE");
    }
  });

  test("returns error when search block not found in implementation", async () => {
    const tool = createTestToolArtifact({
      id: brickId("no-match-tool"),
      implementation: "return 42;",
    });
    const store = mockStore([tool]);
    const deps = makeDeps({ store });

    const result = await executeEdit(deps, {
      brickId: "no-match-tool",
      searchBlock: "return 999;",
      replaceBlock: "return 0;",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as { message: string }).message).toContain("Search block not found");
    }
  });

  test("returns error when verification fails", async () => {
    const tool = createTestToolArtifact({
      id: brickId("verify-fail-tool"),
      implementation: "return 1;",
    });
    const store = mockStore([tool]);
    const pipeline = mockPipeline();
    (pipeline.verify as ReturnType<typeof mock>).mockImplementation(async () => ({
      ok: false as const,
      error: { stage: "sandbox", code: "VERIFICATION_FAILED", message: "sandbox error" },
    }));
    const deps = makeDeps({ store, pipeline });

    const result = await executeEdit(deps, {
      brickId: "verify-fail-tool",
      searchBlock: "return 1;",
      replaceBlock: "return 2;",
    });

    expect(result.ok).toBe(false);
  });

  test("returns error when save fails", async () => {
    const tool = createTestToolArtifact({
      id: brickId("save-fail-tool"),
      implementation: "return 1;",
    });
    const store = mockStore([tool]);
    (store.save as ReturnType<typeof mock>).mockImplementation(async () => ({
      ok: false as const,
      error: { code: "INTERNAL", message: "disk full", retryable: false },
    }));
    const deps = makeDeps({ store });

    const result = await executeEdit(deps, {
      brickId: "save-fail-tool",
      searchBlock: "return 1;",
      replaceBlock: "return 2;",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as { code: string }).code).toBe("SAVE_FAILED");
    }
  });
});

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------

describe("forge_edit — notification", () => {
  test("notifies after successful save", async () => {
    const tool = createTestToolArtifact({
      id: brickId("notify-tool"),
      implementation: "return 1;",
    });
    const store = mockStore([tool]);
    const notifier = {
      notify: mock(async () => {}),
      subscribe: mock(() => () => {}),
    };
    const deps = makeDeps({ store, notifier });

    await executeEdit(deps, {
      brickId: "notify-tool",
      searchBlock: "return 1;",
      replaceBlock: "return 2;",
    });

    // Wait for fire-and-forget notification
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(notifier.notify).toHaveBeenCalled();
  });

  test("does not notify when no notifier is provided", async () => {
    const tool = createTestToolArtifact({
      id: brickId("no-notify-tool"),
      implementation: "return 1;",
    });
    const store = mockStore([tool]);
    const deps = makeDeps({ store, notifier: undefined });

    const result = await executeEdit(deps, {
      brickId: "no-notify-tool",
      searchBlock: "return 1;",
      replaceBlock: "return 2;",
    });

    // Should succeed without errors even without notifier
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Version increment
// ---------------------------------------------------------------------------

describe("forge_edit — version increment", () => {
  test("increments patch version: 0.0.1 → 0.0.2", async () => {
    const tool = createTestToolArtifact({
      id: brickId("v1"),
      implementation: "return 1;",
      version: "0.0.1",
    });
    const store = mockStore([tool]);
    const deps = makeDeps({ store });

    await executeEdit(deps, {
      brickId: "v1",
      searchBlock: "return 1;",
      replaceBlock: "return 2;",
    });

    const saved = (store.save as ReturnType<typeof mock>).mock.calls[0]?.[0] as BrickArtifact;
    expect(saved.version).toBe("0.0.2");
  });

  test("handles malformed version gracefully", async () => {
    const tool = createTestToolArtifact({
      id: brickId("vbad"),
      implementation: "return 1;",
      version: "invalid",
    });
    const store = mockStore([tool]);
    const deps = makeDeps({ store });

    await executeEdit(deps, {
      brickId: "vbad",
      searchBlock: "return 1;",
      replaceBlock: "return 2;",
    });

    const saved = (store.save as ReturnType<typeof mock>).mock.calls[0]?.[0] as BrickArtifact;
    expect(saved.version).toBe("0.0.1");
  });
});
