import { describe, expect, test } from "bun:test";
import type { MemorySearchFilter } from "../types.js";
import { mockBackend, mockError, mockRecord, TEST_MEMORY_DIR, unwrapTool } from "./__test-utils.js";
import { createMemorySearchTool } from "./memory-search.js";

describe("createMemorySearchTool", () => {
  test("builds successfully", () => {
    const result = createMemorySearchTool(mockBackend(), TEST_MEMORY_DIR);
    expect(result.ok).toBe(true);
  });

  test("rejects negative searchLimit at construction", () => {
    const result = createMemorySearchTool(mockBackend(), TEST_MEMORY_DIR, "memory", -5);
    expect(result.ok).toBe(false);
  });

  test("tool has correct name with default prefix", () => {
    const tool = unwrapTool(createMemorySearchTool(mockBackend(), TEST_MEMORY_DIR));
    expect(tool.descriptor.name).toBe("memory_search");
  });
});

describe("memory_search execute", () => {
  test("returns all memories with empty args", async () => {
    const records = [mockRecord()];
    const backend = mockBackend({
      search: async () => ({ ok: true, value: records }),
    });
    const tool = unwrapTool(createMemorySearchTool(backend, TEST_MEMORY_DIR));

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
    const tool = unwrapTool(createMemorySearchTool(backend, TEST_MEMORY_DIR));

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
    const tool = unwrapTool(createMemorySearchTool(backend, TEST_MEMORY_DIR));

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
    const tool = unwrapTool(createMemorySearchTool(backend, TEST_MEMORY_DIR));

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
    const tool = unwrapTool(createMemorySearchTool(backend, TEST_MEMORY_DIR, "memory", 10));

    await tool.execute({ limit: 50 });
    expect(capturedFilter?.limit).toBe(10);
  });

  test("returns validation error for invalid type", async () => {
    const tool = unwrapTool(createMemorySearchTool(mockBackend(), TEST_MEMORY_DIR));
    const result = (await tool.execute({ type: "invalid" })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for invalid timestamp", async () => {
    const tool = unwrapTool(createMemorySearchTool(mockBackend(), TEST_MEMORY_DIR));
    const result = (await tool.execute({
      updated_after: "not-a-date",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("normalizes empty keyword to undefined (match-all)", async () => {
    let capturedFilter: MemorySearchFilter | undefined;
    const backend = mockBackend({
      search: async (filter) => {
        capturedFilter = filter;
        return { ok: true, value: [] };
      },
    });
    const tool = unwrapTool(createMemorySearchTool(backend, TEST_MEMORY_DIR));

    await tool.execute({ keyword: "" });
    expect(capturedFilter?.keyword).toBeUndefined();
  });

  test("normalizes whitespace-only keyword to undefined", async () => {
    let capturedFilter: MemorySearchFilter | undefined;
    const backend = mockBackend({
      search: async (filter) => {
        capturedFilter = filter;
        return { ok: true, value: [] };
      },
    });
    const tool = unwrapTool(createMemorySearchTool(backend, TEST_MEMORY_DIR));

    await tool.execute({ keyword: "   " });
    expect(capturedFilter?.keyword).toBeUndefined();
  });

  test("rejects inverted time window", async () => {
    const tool = unwrapTool(createMemorySearchTool(mockBackend(), TEST_MEMORY_DIR));
    const result = (await tool.execute({
      updated_after: "2026-06-01T00:00:00Z",
      updated_before: "2026-01-01T00:00:00Z",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("updated_after");
  });

  test("rejects non-ISO timestamp formats", async () => {
    const tool = unwrapTool(createMemorySearchTool(mockBackend(), TEST_MEMORY_DIR));
    const result = (await tool.execute({
      updated_after: "March 5, 2026",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns sanitized error on backend failure", async () => {
    const backend = mockBackend({
      search: async () => ({ ok: false, error: mockError("/tmp/mem: disk error") }),
    });
    const tool = unwrapTool(createMemorySearchTool(backend, TEST_MEMORY_DIR));

    const result = (await tool.execute({})) as Record<string, unknown>;
    expect(result.code).toBe("INTERNAL");
    expect(result.error).toBe("Failed to search memories");
  });

  test("returns internal error when backend throws", async () => {
    const backend = mockBackend({
      search: async () => {
        throw new Error("unexpected");
      },
    });
    const tool = unwrapTool(createMemorySearchTool(backend, TEST_MEMORY_DIR));

    const result = (await tool.execute({})) as Record<string, unknown>;
    expect(result.code).toBe("INTERNAL");
  });
});
