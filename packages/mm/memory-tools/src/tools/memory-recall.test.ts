import { describe, expect, test } from "bun:test";
import { mockBackend, mockError, mockRecord, unwrapTool } from "./__test-utils.js";
import { createMemoryRecallTool } from "./memory-recall.js";

describe("createMemoryRecallTool", () => {
  test("builds successfully", () => {
    const result = createMemoryRecallTool(mockBackend());
    expect(result.ok).toBe(true);
  });

  test("tool has correct name with default prefix", () => {
    const tool = unwrapTool(createMemoryRecallTool(mockBackend()));
    expect(tool.descriptor.name).toBe("memory_recall");
  });
});

describe("memory_recall execute", () => {
  test("returns matching memories", async () => {
    const records = [mockRecord(), mockRecord({ id: "rec-2" as never })];
    const backend = mockBackend({
      recall: async () => ({ ok: true, value: records }),
    });
    const tool = unwrapTool(createMemoryRecallTool(backend));

    const result = (await tool.execute({ query: "test" })) as Record<string, unknown>;
    expect(result.count).toBe(2);
    expect(result.results).toEqual(records);
  });

  test("returns empty results for no matches", async () => {
    const tool = unwrapTool(createMemoryRecallTool(mockBackend()));
    const result = (await tool.execute({ query: "nothing" })) as Record<string, unknown>;
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });

  test("clamps limit to max", async () => {
    let capturedLimit: number | undefined;
    const backend = mockBackend({
      recall: async (_query, options) => {
        capturedLimit = options?.limit;
        return { ok: true, value: [] };
      },
    });
    const tool = unwrapTool(createMemoryRecallTool(backend, "memory", 5));

    await tool.execute({ query: "test", limit: 100 });
    expect(capturedLimit).toBe(5);
  });

  test("clamps limit to minimum 1", async () => {
    let capturedLimit: number | undefined;
    const backend = mockBackend({
      recall: async (_query, options) => {
        capturedLimit = options?.limit;
        return { ok: true, value: [] };
      },
    });
    const tool = unwrapTool(createMemoryRecallTool(backend));

    await tool.execute({ query: "test", limit: -5 });
    expect(capturedLimit).toBe(1);
  });

  test("passes tier filter to backend", async () => {
    let capturedTier: string | undefined;
    const backend = mockBackend({
      recall: async (_query, options) => {
        capturedTier = options?.tierFilter;
        return { ok: true, value: [] };
      },
    });
    const tool = unwrapTool(createMemoryRecallTool(backend));

    await tool.execute({ query: "test", tier: "hot" });
    expect(capturedTier).toBe("hot");
  });

  test("defaults tier to all, graphExpand false, no maxHops when omitted", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const backend = mockBackend({
      recall: async (_query, options) => {
        capturedOptions = options as Record<string, unknown> | undefined;
        return { ok: true, value: [] };
      },
    });
    const tool = unwrapTool(createMemoryRecallTool(backend));

    await tool.execute({ query: "test" });
    expect(capturedOptions?.tierFilter).toBe("all");
    expect(capturedOptions?.graphExpand).toBe(false);
    expect("maxHops" in (capturedOptions ?? {})).toBe(false);
  });

  test("includes maxHops when graph_expand is true", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const backend = mockBackend({
      recall: async (_query, options) => {
        capturedOptions = options as Record<string, unknown> | undefined;
        return { ok: true, value: [] };
      },
    });
    const tool = unwrapTool(createMemoryRecallTool(backend));

    await tool.execute({ query: "test", graph_expand: true });
    expect(capturedOptions?.graphExpand).toBe(true);
    expect(capturedOptions?.maxHops).toBe(2);
  });

  test("passes graph expansion options", async () => {
    let capturedExpand: boolean | undefined;
    let capturedHops: number | undefined;
    const backend = mockBackend({
      recall: async (_query, options) => {
        capturedExpand = options?.graphExpand;
        capturedHops = options?.maxHops;
        return { ok: true, value: [] };
      },
    });
    const tool = unwrapTool(createMemoryRecallTool(backend));

    await tool.execute({ query: "test", graph_expand: true, max_hops: 3 });
    expect(capturedExpand).toBe(true);
    expect(capturedHops).toBe(3);
  });

  test("returns validation error for missing query", async () => {
    const tool = unwrapTool(createMemoryRecallTool(mockBackend()));
    const result = (await tool.execute({})) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for invalid tier", async () => {
    const tool = unwrapTool(createMemoryRecallTool(mockBackend()));
    const result = (await tool.execute({
      query: "test",
      tier: "invalid",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("rejects negative max_hops", async () => {
    const tool = unwrapTool(createMemoryRecallTool(mockBackend()));
    const result = (await tool.execute({ query: "test", max_hops: -1 })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("rejects fractional max_hops", async () => {
    const tool = unwrapTool(createMemoryRecallTool(mockBackend()));
    const result = (await tool.execute({ query: "test", max_hops: 1.7 })) as Record<
      string,
      unknown
    >;
    expect(result.code).toBe("VALIDATION");
  });

  test("rejects fractional limit", async () => {
    const tool = unwrapTool(createMemoryRecallTool(mockBackend()));
    const result = (await tool.execute({ query: "test", limit: 5.5 })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("rejects negative recallLimit at construction", () => {
    const result = createMemoryRecallTool(mockBackend(), "memory", -5);
    expect(result.ok).toBe(false);
  });

  test("returns sanitized error on backend failure", async () => {
    const backend = mockBackend({
      recall: async () => ({ ok: false, error: mockError("/var/data: read error") }),
    });
    const tool = unwrapTool(createMemoryRecallTool(backend));

    const result = (await tool.execute({ query: "test" })) as Record<string, unknown>;
    expect(result.code).toBe("INTERNAL");
    expect(result.error).toBe("Failed to recall memories");
  });
});
