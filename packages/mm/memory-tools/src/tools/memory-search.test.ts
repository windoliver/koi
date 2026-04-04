import { describe, expect, test } from "bun:test";
import type { MemorySearchFilter } from "../types.js";
import { mockBackend, mockError, mockRecord, unwrapTool } from "./__test-utils.js";
import { createMemorySearchTool } from "./memory-search.js";

describe("createMemorySearchTool", () => {
  test("builds successfully", () => {
    const result = createMemorySearchTool(mockBackend());
    expect(result.ok).toBe(true);
  });

  test("tool has correct name with default prefix", () => {
    const tool = unwrapTool(createMemorySearchTool(mockBackend()));
    expect(tool.descriptor.name).toBe("memory_search");
  });
});

describe("memory_search execute", () => {
  test("returns all memories with empty args", async () => {
    const records = [mockRecord()];
    const backend = mockBackend({
      search: async () => ({ ok: true, value: records }),
    });
    const tool = unwrapTool(createMemorySearchTool(backend));

    const result = (await tool.execute({})) as Record<string, unknown>;
    expect(result.count).toBe(1);
    expect(result.results).toEqual(records);
  });

  test("passes keyword filter to backend", async () => {
    let capturedFilter: MemorySearchFilter | undefined;
    const backend = mockBackend({
      search: async (filter) => {
        capturedFilter = filter;
        return { ok: true, value: [] };
      },
    });
    const tool = unwrapTool(createMemorySearchTool(backend));

    await tool.execute({ keyword: "testing" });
    expect(capturedFilter?.keyword).toBe("testing");
  });

  test("passes type filter to backend", async () => {
    let capturedFilter: MemorySearchFilter | undefined;
    const backend = mockBackend({
      search: async (filter) => {
        capturedFilter = filter;
        return { ok: true, value: [] };
      },
    });
    const tool = unwrapTool(createMemorySearchTool(backend));

    await tool.execute({ type: "feedback" });
    expect(capturedFilter?.type).toBe("feedback");
  });

  test("converts ISO timestamps to epoch ms", async () => {
    let capturedFilter: MemorySearchFilter | undefined;
    const backend = mockBackend({
      search: async (filter) => {
        capturedFilter = filter;
        return { ok: true, value: [] };
      },
    });
    const tool = unwrapTool(createMemorySearchTool(backend));

    await tool.execute({
      updated_after: "2026-01-01T00:00:00Z",
      updated_before: "2026-06-01T00:00:00Z",
    });
    expect(capturedFilter?.updatedAfter).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(capturedFilter?.updatedBefore).toBe(Date.parse("2026-06-01T00:00:00Z"));
  });

  test("clamps limit to max", async () => {
    let capturedFilter: MemorySearchFilter | undefined;
    const backend = mockBackend({
      search: async (filter) => {
        capturedFilter = filter;
        return { ok: true, value: [] };
      },
    });
    const tool = unwrapTool(createMemorySearchTool(backend, "memory", undefined, 10));

    await tool.execute({ limit: 50 });
    expect(capturedFilter?.limit).toBe(10);
  });

  test("returns validation error for invalid type", async () => {
    const tool = unwrapTool(createMemorySearchTool(mockBackend()));
    const result = (await tool.execute({ type: "invalid" })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for invalid timestamp", async () => {
    const tool = unwrapTool(createMemorySearchTool(mockBackend()));
    const result = (await tool.execute({
      updated_after: "not-a-date",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns internal error on backend failure", async () => {
    const backend = mockBackend({
      search: async () => ({ ok: false, error: mockError("disk error") }),
    });
    const tool = unwrapTool(createMemorySearchTool(backend));

    const result = (await tool.execute({})) as Record<string, unknown>;
    expect(result.code).toBe("INTERNAL");
    expect(result.error).toBe("disk error");
  });

  test("returns internal error when backend throws", async () => {
    const backend = mockBackend({
      search: async () => {
        throw new Error("unexpected");
      },
    });
    const tool = unwrapTool(createMemorySearchTool(backend));

    const result = (await tool.execute({})) as Record<string, unknown>;
    expect(result.code).toBe("INTERNAL");
  });
});
