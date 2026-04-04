import { describe, expect, test } from "bun:test";
import { memoryRecordId, mockBackend, mockError, mockRecord, unwrapTool } from "./__test-utils.js";
import { createMemoryDeleteTool } from "./memory-delete.js";

describe("createMemoryDeleteTool", () => {
  test("builds successfully", () => {
    const result = createMemoryDeleteTool(mockBackend());
    expect(result.ok).toBe(true);
  });

  test("tool has correct name with default prefix", () => {
    const tool = unwrapTool(createMemoryDeleteTool(mockBackend()));
    expect(tool.descriptor.name).toBe("memory_delete");
  });
});

describe("memory_delete execute", () => {
  test("deletes existing memory", async () => {
    const record = mockRecord({ id: memoryRecordId("del-1") });
    const backend = mockBackend({
      get: async () => ({ ok: true, value: record }),
      delete: async () => ({ ok: true, value: undefined }),
    });
    const tool = unwrapTool(createMemoryDeleteTool(backend));

    const result = (await tool.execute({ id: "del-1" })) as Record<string, unknown>;
    expect(result.deleted).toBe(true);
    expect(result.id).toBe("del-1");
  });

  test("returns not found for missing memory", async () => {
    const backend = mockBackend({
      get: async () => ({ ok: true, value: undefined }),
    });
    const tool = unwrapTool(createMemoryDeleteTool(backend));

    const result = (await tool.execute({ id: "missing" })) as Record<string, unknown>;
    expect(result.deleted).toBe(false);
    expect(result.code).toBe("NOT_FOUND");
  });

  test("returns validation error for missing id", async () => {
    const tool = unwrapTool(createMemoryDeleteTool(mockBackend()));
    const result = (await tool.execute({})) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for empty id", async () => {
    const tool = unwrapTool(createMemoryDeleteTool(mockBackend()));
    const result = (await tool.execute({ id: "" })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns internal error when get fails", async () => {
    const backend = mockBackend({
      get: async () => ({ ok: false, error: mockError("read error") }),
    });
    const tool = unwrapTool(createMemoryDeleteTool(backend));

    const result = (await tool.execute({ id: "x" })) as Record<string, unknown>;
    expect(result.code).toBe("INTERNAL");
    expect(result.error).toBe("read error");
  });

  test("returns internal error when delete fails", async () => {
    const backend = mockBackend({
      get: async () => ({ ok: true, value: mockRecord() }),
      delete: async () => ({ ok: false, error: mockError("perm denied") }),
    });
    const tool = unwrapTool(createMemoryDeleteTool(backend));

    const result = (await tool.execute({ id: "x" })) as Record<string, unknown>;
    expect(result.code).toBe("INTERNAL");
    expect(result.error).toBe("perm denied");
  });

  test("returns internal error when backend throws", async () => {
    const backend = mockBackend({
      get: async () => {
        throw new Error("crash");
      },
    });
    const tool = unwrapTool(createMemoryDeleteTool(backend));

    const result = (await tool.execute({ id: "x" })) as Record<string, unknown>;
    expect(result.code).toBe("INTERNAL");
    expect(result.error).toBe("crash");
  });
});
