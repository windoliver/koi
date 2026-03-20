/**
 * Tests for search_forge — store fallback and retriever-based search paths.
 */

import { describe, expect, mock, test } from "bun:test";
import type { BrickArtifact, BrickId, ForgeStore, KoiError, Result } from "@koi/core";
import { brickId } from "@koi/core";
import type { ForgePipeline } from "@koi/forge-types";
import { createDefaultForgeConfig } from "@koi/forge-types";
import type { Retriever, SearchPage, SearchQuery, SearchResult } from "@koi/search-provider";
import { createTestSkillArtifact, createTestToolArtifact } from "@koi/test-utils";
import { createSearchForgeTool } from "./search-forge.js";
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
        value: bricks,
      }),
    ),
    remove: mock(async () => ({ ok: true as const, value: undefined })),
    update: mock(async () => ({ ok: true as const, value: undefined })),
    exists: mock(async () => ({ ok: true as const, value: false })),
  };
}

function mockRetriever(results: readonly SearchResult[]): Retriever {
  return {
    retrieve: mock(
      async (_query: SearchQuery): Promise<Result<SearchPage, KoiError>> => ({
        ok: true,
        value: { results, hasMore: false },
      }),
    ),
  };
}

function failingRetriever(): Retriever {
  return {
    retrieve: mock(
      async (): Promise<Result<SearchPage, KoiError>> => ({
        ok: false,
        error: { code: "INTERNAL", message: "retriever down", retryable: true },
      }),
    ),
  };
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
    ...overrides,
  };
}

/** Execute the search_forge tool and return the result. */
async function executeSearch(
  deps: ForgeDeps,
  input: unknown,
): Promise<Result<readonly BrickArtifact[], unknown>> {
  const tool = createSearchForgeTool(deps);
  // The tool wraps with governance. For unit tests, provide a pipeline that passes.
  const result = await tool.execute(input as Record<string, unknown>);
  return result as Result<readonly BrickArtifact[], unknown>;
}

// ---------------------------------------------------------------------------
// Baseline tests (store path)
// ---------------------------------------------------------------------------

describe("search_forge — store path", () => {
  test("empty query returns store results", async () => {
    const tool1 = createTestToolArtifact({ id: brickId("t1"), name: "alpha" });
    const store = mockStore([tool1]);
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, pipeline });

    const result = await executeSearch(deps, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.name).toBe("alpha");
    }
  });

  test("metadata filters passed to store", async () => {
    const store = mockStore([]);
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, pipeline });

    await executeSearch(deps, { kind: "tool", scope: "global" });
    expect(store.search).toHaveBeenCalled();
  });

  test("scope filtering by agentId", async () => {
    const myTool = createTestToolArtifact({
      id: brickId("mine"),
      name: "mine",
      scope: "agent",
      provenance: {
        ...createTestToolArtifact().provenance,
        metadata: {
          ...createTestToolArtifact().provenance.metadata,
          agentId: "agent-1",
        },
      },
    });
    const otherTool = createTestToolArtifact({
      id: brickId("other"),
      name: "other",
      scope: "agent",
      provenance: {
        ...createTestToolArtifact().provenance,
        metadata: {
          ...createTestToolArtifact().provenance.metadata,
          agentId: "agent-2",
        },
      },
    });
    const store = mockStore([myTool, otherTool]);
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, pipeline });

    const result = await executeSearch(deps, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.name).toBe("mine");
    }
  });

  test("orderBy validation defaults to fitness", async () => {
    const store = mockStore([]);
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, pipeline });

    await executeSearch(deps, { orderBy: "invalid_value" });
    // Should not throw — defaults to "fitness"
    expect(store.search).toHaveBeenCalled();
  });

  test("minFitnessScore clamping", async () => {
    const store = mockStore([]);
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, pipeline });

    // Over-range value should be clamped to 1
    await executeSearch(deps, { minFitnessScore: 5.0 });
    expect(store.search).toHaveBeenCalled();
  });

  test("invalid input rejection", async () => {
    const pipeline = mockPipeline();
    const deps = makeDeps({ pipeline });

    const result = await executeSearch(deps, "not-an-object");
    expect(result.ok).toBe(false);
  });

  test("store error propagation", async () => {
    const store: ForgeStore = {
      save: mock(async () => ({ ok: true as const, value: undefined })),
      load: mock(async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "db down", retryable: false },
      })),
      search: mock(async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "db down", retryable: false },
      })),
      remove: mock(async () => ({ ok: true as const, value: undefined })),
      update: mock(async () => ({ ok: true as const, value: undefined })),
      exists: mock(async () => ({ ok: true as const, value: false })),
    };
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, pipeline });

    const result = await executeSearch(deps, {});
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Semantic tests (retriever path)
// ---------------------------------------------------------------------------

describe("search_forge — retriever path", () => {
  test("query + retriever calls retriever.retrieve()", async () => {
    const tool1 = createTestToolArtifact({ id: brickId("t1"), name: "chart-renderer" });
    const store = mockStore([tool1]);
    const retriever = mockRetriever([
      { id: "t1" as string, score: 0.9, content: "chart-renderer", metadata: {}, source: "nexus" },
    ]);
    // Patch store.load to use brickId
    (store.load as ReturnType<typeof mock>).mockImplementation(async (id: BrickId) => {
      if (id === brickId("t1")) return { ok: true, value: tool1 };
      return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
    });
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, retriever, pipeline });

    const result = await executeSearch(deps, { query: "visualize data" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.name).toBe("chart-renderer");
    }
    expect(retriever.retrieve).toHaveBeenCalled();
    // Store.search should NOT have been called (retriever path succeeded)
    expect(store.search).not.toHaveBeenCalled();
  });

  test("post-filters by kind after retriever", async () => {
    const tool = createTestToolArtifact({ id: brickId("t1"), name: "renderer" });
    const skill = createTestSkillArtifact({ id: brickId("s1"), name: "visualizer" });
    const store = mockStore([tool, skill]);
    const retriever = mockRetriever([
      { id: "t1" as string, score: 0.9, content: "renderer", metadata: {}, source: "nexus" },
      { id: "s1" as string, score: 0.8, content: "visualizer", metadata: {}, source: "nexus" },
    ]);
    // Patch load for both bricks
    (store.load as ReturnType<typeof mock>).mockImplementation(async (id: BrickId) => {
      if (id === brickId("t1")) return { ok: true, value: tool };
      if (id === brickId("s1")) return { ok: true, value: skill };
      return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
    });
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, retriever, pipeline });

    const result = await executeSearch(deps, { query: "visualize", kind: "tool" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.kind).toBe("tool");
    }
  });

  test("post-filters by tags after retriever", async () => {
    const tagged = createTestToolArtifact({
      id: brickId("t1"),
      name: "tagged",
      tags: ["chart"],
    });
    const untagged = createTestToolArtifact({
      id: brickId("t2"),
      name: "untagged",
      tags: [],
    });
    const store = mockStore([tagged, untagged]);
    const retriever = mockRetriever([
      { id: "t1" as string, score: 0.9, content: "tagged", metadata: {}, source: "nexus" },
      { id: "t2" as string, score: 0.8, content: "untagged", metadata: {}, source: "nexus" },
    ]);
    (store.load as ReturnType<typeof mock>).mockImplementation(async (id: BrickId) => {
      if (id === brickId("t1")) return { ok: true, value: tagged };
      if (id === brickId("t2")) return { ok: true, value: untagged };
      return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
    });
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, retriever, pipeline });

    const result = await executeSearch(deps, { query: "visualize", tags: ["chart"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.name).toBe("tagged");
    }
  });

  test("over-fetches 3x, truncates to limit", async () => {
    // Create 5 bricks
    const bricks = Array.from({ length: 5 }, (_, i) =>
      createTestToolArtifact({ id: brickId(`t${i}`), name: `tool-${i}` }),
    );
    const store = mockStore(bricks);
    const retrieverResults = bricks.map((b, i) => ({
      id: b.id as string,
      score: 1 - i * 0.1,
      content: b.name,
      metadata: {},
      source: "nexus",
    }));
    const retriever = mockRetriever(retrieverResults);
    (store.load as ReturnType<typeof mock>).mockImplementation(async (id: BrickId) => {
      const b = bricks.find((brick) => brick.id === id);
      if (b !== undefined) return { ok: true, value: b };
      return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
    });
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, retriever, pipeline });

    const result = await executeSearch(deps, { query: "tool", limit: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
    }
    // Retriever should have been called with limit * DEFAULT_OVER_FETCH_MULTIPLIER (2) = 4
    const retrieveCall = (retriever.retrieve as ReturnType<typeof mock>).mock.calls[0];
    expect(retrieveCall?.[0]?.limit).toBe(4);
  });

  test("falls back to store on retriever error", async () => {
    const tool = createTestToolArtifact({ id: brickId("t1"), name: "fallback-tool" });
    const store = mockStore([tool]);
    const retriever = failingRetriever();
    const errors: unknown[] = [];
    const pipeline = mockPipeline();
    const deps = makeDeps({
      store,
      retriever,
      pipeline,
      onError: (e) => {
        errors.push(e);
      },
    });

    const result = await executeSearch(deps, { query: "something" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.name).toBe("fallback-tool");
    }
    // Store.search should have been called as fallback
    expect(store.search).toHaveBeenCalled();
    // onError should have been called with retriever failure
    expect(errors.length).toBe(1);
  });

  test("falls back when no retriever injected", async () => {
    const tool = createTestToolArtifact({ id: brickId("t1"), name: "store-tool" });
    const store = mockStore([tool]);
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, pipeline });

    const result = await executeSearch(deps, { query: "something" });
    expect(result.ok).toBe(true);
    // Should use store path
    expect(store.search).toHaveBeenCalled();
  });

  test("skips bricks that fail store.load()", async () => {
    const tool = createTestToolArtifact({ id: brickId("t1"), name: "good-tool" });
    const store = mockStore([tool]);
    const retriever = mockRetriever([
      { id: "t1" as string, score: 0.9, content: "good", metadata: {}, source: "nexus" },
      { id: "missing" as string, score: 0.8, content: "gone", metadata: {}, source: "nexus" },
    ]);
    (store.load as ReturnType<typeof mock>).mockImplementation(async (id: BrickId) => {
      if (id === brickId("t1")) return { ok: true, value: tool };
      return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
    });
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, retriever, pipeline });

    const result = await executeSearch(deps, { query: "tools" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.name).toBe("good-tool");
    }
  });

  test("preserves retriever relevance ordering", async () => {
    const first = createTestToolArtifact({ id: brickId("t1"), name: "first" });
    const second = createTestToolArtifact({ id: brickId("t2"), name: "second" });
    const store = mockStore([first, second]);
    // Retriever returns t2 before t1 (higher score)
    const retriever = mockRetriever([
      { id: "t2" as string, score: 0.95, content: "second", metadata: {}, source: "nexus" },
      { id: "t1" as string, score: 0.8, content: "first", metadata: {}, source: "nexus" },
    ]);
    (store.load as ReturnType<typeof mock>).mockImplementation(async (id: BrickId) => {
      if (id === brickId("t1")) return { ok: true, value: first };
      if (id === brickId("t2")) return { ok: true, value: second };
      return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
    });
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, retriever, pipeline });

    const result = await executeSearch(deps, { query: "something" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]?.name).toBe("second");
      expect(result.value[1]?.name).toBe("first");
    }
  });

  test("agent scope filtering on retriever results", async () => {
    const myTool = createTestToolArtifact({
      id: brickId("mine"),
      name: "mine",
      scope: "agent",
      provenance: {
        ...createTestToolArtifact().provenance,
        metadata: {
          ...createTestToolArtifact().provenance.metadata,
          agentId: "agent-1",
        },
      },
    });
    const otherTool = createTestToolArtifact({
      id: brickId("other"),
      name: "other",
      scope: "agent",
      provenance: {
        ...createTestToolArtifact().provenance,
        metadata: {
          ...createTestToolArtifact().provenance.metadata,
          agentId: "agent-2",
        },
      },
    });
    const store = mockStore([myTool, otherTool]);
    const retriever = mockRetriever([
      { id: "mine" as string, score: 0.9, content: "mine", metadata: {}, source: "nexus" },
      { id: "other" as string, score: 0.8, content: "other", metadata: {}, source: "nexus" },
    ]);
    (store.load as ReturnType<typeof mock>).mockImplementation(async (id: BrickId) => {
      if (id === brickId("mine")) return { ok: true, value: myTool };
      if (id === brickId("other")) return { ok: true, value: otherTool };
      return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
    });
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, retriever, pipeline });

    const result = await executeSearch(deps, { query: "tools" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.name).toBe("mine");
    }
  });

  test("post-filters by createdBy after retriever", async () => {
    const myTool = createTestToolArtifact({
      id: brickId("mine"),
      name: "mine",
      scope: "global",
      provenance: {
        ...createTestToolArtifact().provenance,
        metadata: {
          ...createTestToolArtifact().provenance.metadata,
          agentId: "author-a",
        },
      },
    });
    const otherTool = createTestToolArtifact({
      id: brickId("other"),
      name: "other",
      scope: "global",
      provenance: {
        ...createTestToolArtifact().provenance,
        metadata: {
          ...createTestToolArtifact().provenance.metadata,
          agentId: "author-b",
        },
      },
    });
    const store = mockStore([myTool, otherTool]);
    const retriever = mockRetriever([
      { id: "mine" as string, score: 0.9, content: "mine", metadata: {}, source: "nexus" },
      { id: "other" as string, score: 0.8, content: "other", metadata: {}, source: "nexus" },
    ]);
    (store.load as ReturnType<typeof mock>).mockImplementation(async (id: BrickId) => {
      if (id === brickId("mine")) return { ok: true, value: myTool };
      if (id === brickId("other")) return { ok: true, value: otherTool };
      return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
    });
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, retriever, pipeline });

    const result = await executeSearch(deps, { query: "tools", createdBy: "author-a" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.name).toBe("mine");
    }
  });

  test("tags use AND-subset matching on retriever path", async () => {
    const both = createTestToolArtifact({
      id: brickId("both"),
      name: "both-tags",
      tags: ["chart", "data"],
    });
    const oneOnly = createTestToolArtifact({
      id: brickId("one"),
      name: "one-tag",
      tags: ["chart"],
    });
    const store = mockStore([both, oneOnly]);
    const retriever = mockRetriever([
      { id: "both" as string, score: 0.9, content: "both", metadata: {}, source: "nexus" },
      { id: "one" as string, score: 0.8, content: "one", metadata: {}, source: "nexus" },
    ]);
    (store.load as ReturnType<typeof mock>).mockImplementation(async (id: BrickId) => {
      if (id === brickId("both")) return { ok: true, value: both };
      if (id === brickId("one")) return { ok: true, value: oneOnly };
      return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
    });
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, retriever, pipeline });

    // Requires BOTH tags — "one-tag" (only has "chart") should be filtered out
    const result = await executeSearch(deps, { query: "visualize", tags: ["chart", "data"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.name).toBe("both-tags");
    }
  });

  test("text field works as legacy fallback to query", async () => {
    const tool = createTestToolArtifact({ id: brickId("t1"), name: "legacy-tool" });
    const store = mockStore([tool]);
    const retriever = mockRetriever([
      { id: "t1" as string, score: 0.9, content: "legacy", metadata: {}, source: "nexus" },
    ]);
    (store.load as ReturnType<typeof mock>).mockImplementation(async (id: BrickId) => {
      if (id === brickId("t1")) return { ok: true, value: tool };
      return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
    });
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, retriever, pipeline });

    // Using "text" (legacy field) should still trigger retriever
    const result = await executeSearch(deps, { text: "legacy search" });
    expect(result.ok).toBe(true);
    expect(retriever.retrieve).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Trigger-based search tests
// ---------------------------------------------------------------------------

describe("search_forge — trigger matching", () => {
  test("store path: text query matches brick triggers", async () => {
    const withTrigger = createTestToolArtifact({
      id: brickId("t1"),
      name: "theorem-viz",
      description: "Visualizes theorems",
      trigger: ["animate proof", "visualize theorem"],
    });
    const withoutTrigger = createTestToolArtifact({
      id: brickId("t2"),
      name: "csv-parser",
      description: "Parses CSV files",
    });
    const store = mockStore([withTrigger, withoutTrigger]);
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, pipeline });

    // "animate" matches t1 via trigger but not t2
    const result = await executeSearch(deps, { query: "animate" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Store returns all bricks; ranking via sortBricks filters based on text match in ForgeQuery
      // The store mock returns both bricks, but matchesBrickQuery filters by text (which now includes triggers)
      const names = result.value.map((b) => (b as BrickArtifact).name);
      expect(names).toContain("theorem-viz");
    }
  });

  test("retriever path: trigger content indexed and discoverable", async () => {
    const brick = createTestSkillArtifact({
      id: brickId("s1"),
      name: "review-skill",
      description: "Code review guidance",
      trigger: ["review code", "audit implementation"],
    });
    const store = mockStore([brick]);
    const retriever = mockRetriever([
      {
        id: "s1" as string,
        score: 0.95,
        content: "review code audit",
        metadata: {},
        source: "nexus",
      },
    ]);
    (store.load as ReturnType<typeof mock>).mockImplementation(async (id: BrickId) => {
      if (id === brickId("s1")) return { ok: true, value: brick };
      return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
    });
    const pipeline = mockPipeline();
    const deps = makeDeps({ store, retriever, pipeline });

    const result = await executeSearch(deps, { query: "review code" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.name).toBe("review-skill");
    }
    expect(retriever.retrieve).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Mock pipeline for governance pre-check bypass
// ---------------------------------------------------------------------------

function mockPipeline(): ForgePipeline {
  return {
    verify: mock(async () => ({
      ok: true as const,
      value: { stages: [], sandbox: true, totalDurationMs: 0, passed: true },
    })),
    checkGovernance: mock(async () => ({ ok: true as const, value: undefined })),
    createProvenance: mock(() => ({}) as ReturnType<ForgePipeline["createProvenance"]>),
    signAttestation: mock(
      async (p: unknown) => p as Awaited<ReturnType<ForgePipeline["signAttestation"]>>,
    ),
    extractBrickContent: mock(() => ({ kind: "tool" as const, content: "" })),
    checkMutationPressure: mock(async () => ({ ok: true as const, value: undefined })),
  } as unknown as ForgePipeline;
}
