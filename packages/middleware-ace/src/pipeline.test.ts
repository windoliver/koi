import { describe, expect, mock, test } from "bun:test";
import type { AceConfig } from "./config.js";
import {
  createLlmPipeline,
  createStatPipeline,
  estimatePlaybookTokens,
  isLlmPipelineEnabled,
} from "./pipeline.js";
import {
  createInMemoryPlaybookStore,
  createInMemoryStructuredPlaybookStore,
  createInMemoryTrajectoryStore,
} from "./stores.js";
import { createTrajectoryBuffer } from "./trajectory-buffer.js";
import type { StructuredPlaybook, TrajectoryEntry } from "./types.js";

function makeEntry(overrides?: Partial<TrajectoryEntry>): TrajectoryEntry {
  return {
    turnIndex: 0,
    timestamp: 1000,
    kind: "tool_call",
    identifier: "tool-a",
    outcome: "success",
    durationMs: 50,
    ...overrides,
  };
}

function makeMinimalConfig(overrides?: Partial<AceConfig>): AceConfig {
  return {
    trajectoryStore: createInMemoryTrajectoryStore(),
    playbookStore: createInMemoryPlaybookStore(),
    ...overrides,
  };
}

function makePlaybook(overrides?: Partial<StructuredPlaybook>): StructuredPlaybook {
  return {
    id: "test-pb",
    title: "Test Playbook",
    sections: [
      {
        name: "Strategy",
        slug: "str",
        bullets: [
          {
            id: "[str-00000]",
            content: "Be careful",
            helpful: 3,
            harmful: 0,
            createdAt: 100,
            updatedAt: 100,
          },
        ],
      },
    ],
    tags: [],
    source: "curated",
    createdAt: 100,
    updatedAt: 100,
    sessionCount: 1,
    ...overrides,
  };
}

// ── isLlmPipelineEnabled ──

describe("isLlmPipelineEnabled", () => {
  test("returns false when no LLM components configured", () => {
    const config = makeMinimalConfig();
    expect(isLlmPipelineEnabled(config)).toBe(false);
  });

  test("returns false when only reflector configured", () => {
    const config = makeMinimalConfig({
      reflector: {
        analyze: mock(() => Promise.resolve({ rootCause: "", keyInsight: "", bulletTags: [] })),
      },
    });
    expect(isLlmPipelineEnabled(config)).toBe(false);
  });

  test("returns false when only reflector and curator configured", () => {
    const config = makeMinimalConfig({
      reflector: {
        analyze: mock(() => Promise.resolve({ rootCause: "", keyInsight: "", bulletTags: [] })),
      },
      curator: { curate: mock(() => Promise.resolve([])) },
    });
    expect(isLlmPipelineEnabled(config)).toBe(false);
  });

  test("returns true when all three components configured", () => {
    const config = makeMinimalConfig({
      reflector: {
        analyze: mock(() => Promise.resolve({ rootCause: "", keyInsight: "", bulletTags: [] })),
      },
      curator: { curate: mock(() => Promise.resolve([])) },
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
    });
    expect(isLlmPipelineEnabled(config)).toBe(true);
  });
});

// ── createStatPipeline ──

describe("createStatPipeline", () => {
  test("calls onCurate when candidates are produced", async () => {
    const onCurate = mock(() => {});
    const config = makeMinimalConfig({ onCurate });
    const pipeline = createStatPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    // Record entries that will produce stats
    const entry = makeEntry({ identifier: "tool-a", outcome: "success", timestamp: 1000 });
    buffer.record(entry);

    await pipeline.consolidate([entry], "s1", 1, () => 1000, buffer);
    expect(onCurate).toHaveBeenCalled();
  });

  test("saves playbooks to playbookStore", async () => {
    const playbookStore = createInMemoryPlaybookStore();
    const config = makeMinimalConfig({ playbookStore });
    const pipeline = createStatPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    const entry = makeEntry({ identifier: "tool-x", outcome: "success", timestamp: 1000 });
    buffer.record(entry);

    await pipeline.consolidate([entry], "s1", 1, () => 1000, buffer);
    const playbooks = await playbookStore.list();
    expect(playbooks.length).toBeGreaterThan(0);
  });

  test("does not call onCurate when no candidates above threshold", async () => {
    const onCurate = mock(() => {});
    const config = makeMinimalConfig({ onCurate, minCurationScore: 1.0 });
    const pipeline = createStatPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    // All failures → low score
    const entry = makeEntry({ identifier: "tool-a", outcome: "failure", timestamp: 1000 });
    buffer.record(entry);

    await pipeline.consolidate([entry], "s1", 100, () => 1000, buffer);
    expect(onCurate).not.toHaveBeenCalled();
  });

  test("uses custom scorer when provided", async () => {
    const customScorer = mock(() => 0.99);
    const playbookStore = createInMemoryPlaybookStore();
    const config = makeMinimalConfig({ playbookStore, scorer: customScorer });
    const pipeline = createStatPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    const entry = makeEntry({ identifier: "tool-a", outcome: "success", timestamp: 1000 });
    buffer.record(entry);

    await pipeline.consolidate([entry], "s1", 1, () => 1000, buffer);
    expect(customScorer).toHaveBeenCalled();
    const playbooks = await playbookStore.list();
    expect(playbooks.length).toBeGreaterThan(0);
  });
});

// ── createLlmPipeline ──

describe("createLlmPipeline", () => {
  test("throws when reflector is missing", () => {
    const config = makeMinimalConfig({
      curator: { curate: mock(() => Promise.resolve([])) },
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
    });
    expect(() => createLlmPipeline(config)).toThrow("reflector");
  });

  test("throws when curator is missing", () => {
    const config = makeMinimalConfig({
      reflector: {
        analyze: mock(() => Promise.resolve({ rootCause: "", keyInsight: "", bulletTags: [] })),
      },
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
    });
    expect(() => createLlmPipeline(config)).toThrow("curator");
  });

  test("throws when structuredPlaybookStore is missing", () => {
    const config = makeMinimalConfig({
      reflector: {
        analyze: mock(() => Promise.resolve({ rootCause: "", keyInsight: "", bulletTags: [] })),
      },
      curator: { curate: mock(() => Promise.resolve([])) },
    });
    expect(() => createLlmPipeline(config)).toThrow("structuredPlaybookStore");
  });

  test("full lifecycle: reflect → curate → apply → persist", async () => {
    const store = createInMemoryStructuredPlaybookStore();
    const analyze = mock(() =>
      Promise.resolve({
        rootCause: "Tools were used efficiently",
        keyInsight: "Cache results to avoid re-fetching",
        bulletTags: [],
      }),
    );
    const curate = mock(() =>
      Promise.resolve([
        { kind: "add" as const, section: "str", content: "Cache intermediate results" },
      ]),
    );

    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate },
      structuredPlaybookStore: store,
    });
    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(100);
    const entry = makeEntry({ outcome: "success" });

    await pipeline.consolidate([entry], "session-1", 1, () => 2000, buffer);

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(curate).toHaveBeenCalledTimes(1);

    const saved = await store.get("ace:structured:session-1");
    expect(saved).toBeDefined();
    expect(saved?.sessionCount).toBe(1);
    expect(saved?.sections.some((s) => s.bullets.length > 0)).toBe(true);
  });

  test("creates empty playbook when not in store", async () => {
    const store = createInMemoryStructuredPlaybookStore();
    const analyze = mock(() => Promise.resolve({ rootCause: "", keyInsight: "", bulletTags: [] }));
    const curate = mock(() => Promise.resolve([]));

    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate },
      structuredPlaybookStore: store,
    });
    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    await pipeline.consolidate([makeEntry()], "new-session", 1, () => 3000, buffer);

    // Reflector received empty playbook with 3 default sections
    expect(analyze).toHaveBeenCalledTimes(1);
    const calls = analyze.mock.calls as unknown as ReadonlyArray<readonly [unknown]>;
    const input = calls[0]?.[0] as
      | { readonly playbook: { readonly sections: ReadonlyArray<{ readonly slug: string }> } }
      | undefined;
    expect(input?.playbook.sections).toHaveLength(3);
    expect(input?.playbook.sections.map((s) => s.slug)).toEqual(["str", "err", "tool"]);
  });

  test("uses existing playbook from store", async () => {
    const store = createInMemoryStructuredPlaybookStore();
    const existingPb = makePlaybook({ id: "ace:structured:s1", sessionCount: 5 });
    await store.save(existingPb);

    const analyze = mock(() => Promise.resolve({ rootCause: "", keyInsight: "", bulletTags: [] }));
    const curate = mock(() => Promise.resolve([]));

    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate },
      structuredPlaybookStore: store,
    });
    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    await pipeline.consolidate([makeEntry()], "s1", 1, () => 4000, buffer);

    const saved = await store.get("ace:structured:s1");
    expect(saved?.sessionCount).toBe(6); // 5 + 1
  });

  test("applies bullet credit assignment from reflector tags", async () => {
    const store = createInMemoryStructuredPlaybookStore();
    const pb = makePlaybook({ id: "ace:structured:s1" });
    await store.save(pb);

    const analyze = mock(() =>
      Promise.resolve({
        rootCause: "Good tool use",
        keyInsight: "Keep it up",
        bulletTags: [{ id: "[str-00000]", tag: "helpful" as const }],
      }),
    );
    const curate = mock(() => Promise.resolve([]));

    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate },
      structuredPlaybookStore: store,
    });
    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    await pipeline.consolidate([makeEntry()], "s1", 1, () => 5000, buffer);

    const saved = await store.get("ace:structured:s1");
    const bullet = saved?.sections[0]?.bullets[0];
    expect(bullet?.helpful).toBe(4); // 3 (original) + 1
    expect(bullet?.harmful).toBe(0);
  });

  test("passes cited bullet IDs from trajectory to reflector", async () => {
    const store = createInMemoryStructuredPlaybookStore();
    const analyze = mock(() => Promise.resolve({ rootCause: "", keyInsight: "", bulletTags: [] }));
    const curate = mock(() => Promise.resolve([]));

    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate },
      structuredPlaybookStore: store,
    });
    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    const entries = [
      makeEntry({ bulletIds: ["[str-00000]", "[err-00001]"] }),
      makeEntry({ bulletIds: ["[str-00000]"] }),
      makeEntry(), // no bulletIds
    ];

    await pipeline.consolidate(entries, "s1", 1, () => 6000, buffer);

    expect(analyze).toHaveBeenCalledTimes(1);
    const calls = analyze.mock.calls as unknown as ReadonlyArray<readonly [unknown]>;
    const input = calls[0]?.[0] as { readonly citedBulletIds: readonly string[] } | undefined;
    expect(input?.citedBulletIds).toEqual(["[str-00000]", "[err-00001]", "[str-00000]"]);
  });

  test("applies harmful bullet credit assignment from reflector tags", async () => {
    const store = createInMemoryStructuredPlaybookStore();
    const pb = makePlaybook({ id: "ace:structured:s1" });
    await store.save(pb);

    const analyze = mock(() =>
      Promise.resolve({
        rootCause: "Bad tool use",
        keyInsight: "Avoid this pattern",
        bulletTags: [{ id: "[str-00000]", tag: "harmful" as const }],
      }),
    );
    const curate = mock(() => Promise.resolve([]));

    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate },
      structuredPlaybookStore: store,
    });
    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    await pipeline.consolidate([makeEntry()], "s1", 1, () => 5000, buffer);

    const saved = await store.get("ace:structured:s1");
    const bullet = saved?.sections[0]?.bullets[0];
    expect(bullet?.helpful).toBe(3); // unchanged
    expect(bullet?.harmful).toBe(1); // 0 + 1
  });

  test("neutral tag leaves counters unchanged", async () => {
    const store = createInMemoryStructuredPlaybookStore();
    const pb = makePlaybook({ id: "ace:structured:s1" });
    await store.save(pb);

    const analyze = mock(() =>
      Promise.resolve({
        rootCause: "",
        keyInsight: "",
        bulletTags: [{ id: "[str-00000]", tag: "neutral" as const }],
      }),
    );
    const curate = mock(() => Promise.resolve([]));

    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate },
      structuredPlaybookStore: store,
    });
    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    await pipeline.consolidate([makeEntry()], "s1", 1, () => 5000, buffer);

    const saved = await store.get("ace:structured:s1");
    const bullet = saved?.sections[0]?.bullets[0];
    expect(bullet?.helpful).toBe(3); // unchanged
    expect(bullet?.harmful).toBe(0); // unchanged
  });

  test("propagates error when reflector.analyze rejects", async () => {
    const store = createInMemoryStructuredPlaybookStore();
    const analyze = mock(() => Promise.reject(new Error("LLM unavailable")));
    const curate = mock(() => Promise.resolve([]));

    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate },
      structuredPlaybookStore: store,
    });
    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    await expect(pipeline.consolidate([makeEntry()], "s1", 1, () => 1000, buffer)).rejects.toThrow(
      "LLM unavailable",
    );
  });

  test("propagates error when curator.curate rejects", async () => {
    const store = createInMemoryStructuredPlaybookStore();
    const analyze = mock(() => Promise.resolve({ rootCause: "", keyInsight: "", bulletTags: [] }));
    const curate = mock(() => Promise.reject(new Error("Curator failed")));

    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate },
      structuredPlaybookStore: store,
    });
    const pipeline = createLlmPipeline(config);
    const buffer = createTrajectoryBuffer(100);

    await expect(pipeline.consolidate([makeEntry()], "s1", 1, () => 1000, buffer)).rejects.toThrow(
      "Curator failed",
    );
  });
});

// ── computeOutcome (tested indirectly via reflector input) ──

describe("computeOutcome (via reflector input)", () => {
  function setupPipeline(): {
    readonly analyze: ReturnType<typeof mock>;
    readonly pipeline: ReturnType<typeof createLlmPipeline>;
    readonly buffer: ReturnType<typeof createTrajectoryBuffer>;
  } {
    const analyze = mock(() => Promise.resolve({ rootCause: "", keyInsight: "", bulletTags: [] }));
    const config = makeMinimalConfig({
      reflector: { analyze },
      curator: { curate: mock(() => Promise.resolve([])) },
      structuredPlaybookStore: createInMemoryStructuredPlaybookStore(),
    });
    return {
      analyze,
      pipeline: createLlmPipeline(config),
      buffer: createTrajectoryBuffer(100),
    };
  }

  test("all successes → 'success'", async () => {
    const { analyze, pipeline, buffer } = setupPipeline();
    const entries = [makeEntry({ outcome: "success" }), makeEntry({ outcome: "success" })];
    await pipeline.consolidate(entries, "s1", 1, () => 1000, buffer);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0]?.[0]?.outcome).toBe("success");
  });

  test("all failures → 'failure'", async () => {
    const { analyze, pipeline, buffer } = setupPipeline();
    const entries = [makeEntry({ outcome: "failure" }), makeEntry({ outcome: "failure" })];
    await pipeline.consolidate(entries, "s1", 1, () => 1000, buffer);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0]?.[0]?.outcome).toBe("failure");
  });

  test("mixed outcomes → 'mixed'", async () => {
    const { analyze, pipeline, buffer } = setupPipeline();
    const entries = [makeEntry({ outcome: "success" }), makeEntry({ outcome: "failure" })];
    await pipeline.consolidate(entries, "s1", 1, () => 1000, buffer);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0]?.[0]?.outcome).toBe("mixed");
  });

  test("empty entries → 'mixed'", async () => {
    const { analyze, pipeline, buffer } = setupPipeline();
    await pipeline.consolidate([], "s1", 1, () => 1000, buffer);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0]?.[0]?.outcome).toBe("mixed");
  });

  test("retry-only entries → 'failure'", async () => {
    const { analyze, pipeline, buffer } = setupPipeline();
    const entries = [makeEntry({ outcome: "retry" }), makeEntry({ outcome: "retry" })];
    await pipeline.consolidate(entries, "s1", 1, () => 1000, buffer);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0]?.[0]?.outcome).toBe("failure");
  });
});

// ── estimatePlaybookTokens ──

describe("estimatePlaybookTokens", () => {
  test("uses default tokenizer when estimateTokens not provided", () => {
    const config = makeMinimalConfig();
    const pb = makePlaybook();
    const tokens = estimatePlaybookTokens(pb, config);
    expect(tokens).toBeGreaterThan(0);
  });

  test("uses custom tokenizer when provided", () => {
    const customTokenizer = mock(() => 42);
    const config = makeMinimalConfig({ estimateTokens: customTokenizer });
    const pb = makePlaybook();
    const tokens = estimatePlaybookTokens(pb, config);
    expect(customTokenizer).toHaveBeenCalled();
    expect(tokens).toBe(42);
  });
});
