import { describe, expect, test } from "bun:test";
import { memoryRecordId, mockBackend, mockError, mockRecord, unwrapTool } from "./__test-utils.js";
import { createMemoryStoreTool } from "./memory-store.js";

describe("createMemoryStoreTool", () => {
  test("builds successfully", () => {
    const result = createMemoryStoreTool(mockBackend());
    expect(result.ok).toBe(true);
  });

  test("tool has correct name with default prefix", () => {
    const tool = unwrapTool(createMemoryStoreTool(mockBackend()));
    expect(tool.descriptor.name).toBe("memory_store");
  });

  test("tool has correct name with custom prefix", () => {
    const tool = unwrapTool(createMemoryStoreTool(mockBackend(), "agent"));
    expect(tool.descriptor.name).toBe("agent_store");
  });
});

describe("memory_store execute", () => {
  const validArgs = {
    name: "test memory",
    description: "a test",
    type: "user",
    content: "Some content.",
  };

  test("stores a new memory record", async () => {
    const record = mockRecord();
    const backend = mockBackend({ store: async () => ({ ok: true, value: record }) });
    const tool = unwrapTool(createMemoryStoreTool(backend));

    const result = (await tool.execute(validArgs)) as Record<string, unknown>;
    expect(result.stored).toBe(true);
    expect(result.id).toBe(record.id);
    expect(result.filePath).toBe(record.filePath);
  });

  test("returns dedup warning when duplicate exists", async () => {
    const existing = mockRecord({ id: memoryRecordId("existing-1") });
    const backend = mockBackend({
      findByName: async () => ({ ok: true, value: existing }),
    });
    const tool = unwrapTool(createMemoryStoreTool(backend));

    const result = (await tool.execute(validArgs)) as Record<string, unknown>;
    expect(result.stored).toBe(false);
    expect(result.duplicate).toEqual({ id: "existing-1", name: existing.name });
    expect(result.message).toContain("force: true");
  });

  test("force updates existing record", async () => {
    const existing = mockRecord({ id: memoryRecordId("existing-1") });
    const updated = mockRecord({ id: memoryRecordId("existing-1"), content: "Updated" });
    const backend = mockBackend({
      findByName: async () => ({ ok: true, value: existing }),
      update: async () => ({ ok: true, value: updated }),
    });
    const tool = unwrapTool(createMemoryStoreTool(backend));

    const result = (await tool.execute({ ...validArgs, force: true })) as Record<string, unknown>;
    expect(result.stored).toBe(true);
    expect(result.updated).toBe(true);
    expect(result.id).toBe("existing-1");
  });

  test("force creates new when no duplicate", async () => {
    const record = mockRecord();
    const backend = mockBackend({
      findByName: async () => ({ ok: true, value: undefined }),
      store: async () => ({ ok: true, value: record }),
    });
    const tool = unwrapTool(createMemoryStoreTool(backend));

    const result = (await tool.execute({ ...validArgs, force: true })) as Record<string, unknown>;
    expect(result.stored).toBe(true);
    expect(result.id).toBe(record.id);
  });

  test("returns validation error for missing name", async () => {
    const tool = unwrapTool(createMemoryStoreTool(mockBackend()));
    const result = (await tool.execute({
      description: "a test",
      type: "user",
      content: "c",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for missing type", async () => {
    const tool = unwrapTool(createMemoryStoreTool(mockBackend()));
    const result = (await tool.execute({
      name: "test",
      description: "a test",
      content: "c",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for invalid type", async () => {
    const tool = unwrapTool(createMemoryStoreTool(mockBackend()));
    const result = (await tool.execute({
      ...validArgs,
      type: "invalid",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for empty content", async () => {
    const tool = unwrapTool(createMemoryStoreTool(mockBackend()));
    const result = (await tool.execute({
      ...validArgs,
      content: "",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns sanitized internal error when backend.store fails", async () => {
    const backend = mockBackend({
      store: async () => ({ ok: false, error: mockError("/usr/local/data: permission denied") }),
    });
    const tool = unwrapTool(createMemoryStoreTool(backend));

    const result = (await tool.execute(validArgs)) as Record<string, unknown>;
    expect(result.code).toBe("INTERNAL");
    expect(result.error).toBe("Failed to store memory");
    expect(result.error).not.toContain("/usr/local");
  });

  test("returns validation error when name is only control chars", async () => {
    const tool = unwrapTool(createMemoryStoreTool(mockBackend()));
    const result = (await tool.execute({
      ...validArgs,
      name: "\x01\x02\x03",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("name");
  });

  test("returns sanitized error when backend throws", async () => {
    const backend = mockBackend({
      findByName: async () => {
        throw new Error("ENOENT: /private/var/data/memory");
      },
    });
    const tool = unwrapTool(createMemoryStoreTool(backend));

    const result = (await tool.execute(validArgs)) as Record<string, unknown>;
    expect(result.code).toBe("INTERNAL");
    expect(result.error).toBe("Failed to store memory");
    expect(result.error).not.toContain("ENOENT");
  });
});
