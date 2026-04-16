import { describe, expect, test } from "bun:test";
import type { StoreWithDedupResult } from "../types.js";
import {
  atomicInMemoryBackend,
  memoryRecordId,
  mockBackend,
  mockError,
  mockRecord,
  TEST_MEMORY_DIR,
  unwrapTool,
} from "./__test-utils.js";
import { createMemoryStoreTool } from "./memory-store.js";

describe("createMemoryStoreTool", () => {
  test("builds successfully", () => {
    const result = createMemoryStoreTool(mockBackend(), TEST_MEMORY_DIR);
    expect(result.ok).toBe(true);
  });

  test("tool has correct name with default prefix", () => {
    const tool = unwrapTool(createMemoryStoreTool(mockBackend(), TEST_MEMORY_DIR));
    expect(tool.descriptor.name).toBe("memory_store");
  });

  test("tool has correct name with custom prefix", () => {
    const tool = unwrapTool(createMemoryStoreTool(mockBackend(), TEST_MEMORY_DIR, "agent"));
    expect(tool.descriptor.name).toBe("agent_store");
  });

  test("tool is sandboxed with filesystem capabilities", () => {
    const tool = unwrapTool(createMemoryStoreTool(mockBackend(), TEST_MEMORY_DIR));
    expect(tool.policy.sandbox).toBe(true);
    expect(tool.policy.capabilities.filesystem?.read).toContain(TEST_MEMORY_DIR);
    expect(tool.policy.capabilities.filesystem?.write).toContain(TEST_MEMORY_DIR);
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
    const backend = mockBackend({
      storeWithDedup: async () => ({
        ok: true,
        value: { action: "created", record } as StoreWithDedupResult,
      }),
    });
    const tool = unwrapTool(createMemoryStoreTool(backend, TEST_MEMORY_DIR));

    const result = (await tool.execute(validArgs)) as Record<string, unknown>;
    expect(result.stored).toBe(true);
    expect(result.id).toBe(record.id);
    // #1725: filePath removed from output — it was a bare filename that
    // misled the model about where data was written.
    expect("filePath" in result).toBe(false);
  });

  test("returns dedup warning when duplicate exists", async () => {
    const existing = mockRecord({ id: memoryRecordId("existing-1") });
    const backend = mockBackend({
      storeWithDedup: async () => ({
        ok: true,
        value: { action: "conflict", existing } as StoreWithDedupResult,
      }),
    });
    const tool = unwrapTool(createMemoryStoreTool(backend, TEST_MEMORY_DIR));

    const result = (await tool.execute(validArgs)) as Record<string, unknown>;
    expect(result.stored).toBe(false);
    expect(result.duplicate).toEqual({ id: "existing-1", name: existing.name });
    expect(result.message).toContain("force: true");
  });

  test("force updates existing record", async () => {
    const updated = mockRecord({ id: memoryRecordId("existing-1"), content: "Updated" });
    const backend = mockBackend({
      storeWithDedup: async () => ({
        ok: true,
        value: { action: "updated", record: updated } as StoreWithDedupResult,
      }),
    });
    const tool = unwrapTool(createMemoryStoreTool(backend, TEST_MEMORY_DIR));

    const result = (await tool.execute({ ...validArgs, force: true })) as Record<string, unknown>;
    expect(result.stored).toBe(true);
    expect(result.updated).toBe(true);
    expect(result.id).toBe("existing-1");
  });

  test("force creates new when no duplicate", async () => {
    const record = mockRecord();
    const backend = mockBackend({
      storeWithDedup: async () => ({
        ok: true,
        value: { action: "created", record } as StoreWithDedupResult,
      }),
    });
    const tool = unwrapTool(createMemoryStoreTool(backend, TEST_MEMORY_DIR));

    const result = (await tool.execute({ ...validArgs, force: true })) as Record<string, unknown>;
    expect(result.stored).toBe(true);
    expect(result.id).toBe(record.id);
  });

  test("returns validation error for missing name", async () => {
    const tool = unwrapTool(createMemoryStoreTool(mockBackend(), TEST_MEMORY_DIR));
    const result = (await tool.execute({
      description: "a test",
      type: "user",
      content: "c",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for missing type", async () => {
    const tool = unwrapTool(createMemoryStoreTool(mockBackend(), TEST_MEMORY_DIR));
    const result = (await tool.execute({
      name: "test",
      description: "a test",
      content: "c",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for invalid type", async () => {
    const tool = unwrapTool(createMemoryStoreTool(mockBackend(), TEST_MEMORY_DIR));
    const result = (await tool.execute({
      ...validArgs,
      type: "invalid",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for empty content", async () => {
    const tool = unwrapTool(createMemoryStoreTool(mockBackend(), TEST_MEMORY_DIR));
    const result = (await tool.execute({
      ...validArgs,
      content: "",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns structured remediation when backend reports 'corrupted'", async () => {
    const backend = mockBackend({
      storeWithDedup: async () => ({
        ok: true,
        value: {
          action: "corrupted",
          canonicalName: "Dup Key",
          conflictingIds: ["dup-key", "dup-key-2"],
        } as StoreWithDedupResult,
      }),
    });
    const tool = unwrapTool(createMemoryStoreTool(backend, TEST_MEMORY_DIR));

    const result = (await tool.execute(validArgs)) as Record<string, unknown>;
    expect(result.stored).toBe(false);
    expect(result.corrupted).toEqual({
      canonicalName: "Dup Key",
      conflictingIds: ["dup-key", "dup-key-2"],
    });
    expect(result.message).toContain("2 records share");
    expect(result.message).toContain("memory_delete");
  });

  test("returns sanitized internal error when backend.storeWithDedup fails", async () => {
    const backend = mockBackend({
      storeWithDedup: async () => ({
        ok: false,
        error: mockError("/usr/local/data: permission denied"),
      }),
    });
    const tool = unwrapTool(createMemoryStoreTool(backend, TEST_MEMORY_DIR));

    const result = (await tool.execute(validArgs)) as Record<string, unknown>;
    expect(result.code).toBe("INTERNAL");
    expect(result.error).toBe("Failed to store memory");
    expect(result.error).not.toContain("/usr/local");
  });

  test("returns validation error when name is only control chars", async () => {
    const tool = unwrapTool(createMemoryStoreTool(mockBackend(), TEST_MEMORY_DIR));
    const result = (await tool.execute({
      ...validArgs,
      name: "\x01\x02\x03",
    })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
    expect(result.error).toContain("name");
  });

  test("returns sanitized error when backend throws", async () => {
    const backend = mockBackend({
      storeWithDedup: async () => {
        throw new Error("ENOENT: /private/var/data/memory");
      },
    });
    const tool = unwrapTool(createMemoryStoreTool(backend, TEST_MEMORY_DIR));

    const result = (await tool.execute(validArgs)) as Record<string, unknown>;
    expect(result.code).toBe("INTERNAL");
    expect(result.error).toBe("Failed to store memory");
    expect(result.error).not.toContain("ENOENT");
  });
});

describe("memory_store atomic dedup", () => {
  const validArgs = {
    name: "test memory",
    description: "a test",
    type: "user" as const,
    content: "Some content.",
  };

  test("concurrent stores with same name+type+payload: one created, rest replayed", async () => {
    const backend = atomicInMemoryBackend();
    const tool = unwrapTool(createMemoryStoreTool(backend, TEST_MEMORY_DIR));

    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, () => tool.execute(validArgs) as Promise<Record<string, unknown>>),
    );

    // All succeed (exact-payload replay is transparent)
    expect(results.every((r) => r.stored === true)).toBe(true);

    const created = results.filter((r) => r.replayed === undefined);
    const replayed = results.filter((r) => r.replayed === true);

    expect(created.length).toBe(1);
    expect(replayed.length).toBe(N - 1);

    // All reference the same record id
    const createdId = created[0]?.id;
    for (const r of replayed) {
      expect(r.id).toBe(createdId);
    }
  });

  test("concurrent stores with same name+type but different payload: one created, rest conflict", async () => {
    const backend = atomicInMemoryBackend();
    const tool = unwrapTool(createMemoryStoreTool(backend, TEST_MEMORY_DIR));

    const N = 5;
    const results = await Promise.all(
      Array.from(
        { length: N },
        (_, i) =>
          tool.execute({
            ...validArgs,
            content: `Content variant ${String(i)}`,
          }) as Promise<Record<string, unknown>>,
      ),
    );

    const created = results.filter((r) => r.stored === true && r.replayed === undefined);
    const conflicts = results.filter((r) => r.stored === false);

    expect(created.length).toBe(1);
    expect(conflicts.length).toBe(N - 1);
  });

  test("retry-after-timeout: exact-payload replay returns stored+replayed with same id", async () => {
    const backend = atomicInMemoryBackend();
    const tool = unwrapTool(createMemoryStoreTool(backend, TEST_MEMORY_DIR));

    const first = (await tool.execute(validArgs)) as Record<string, unknown>;
    const second = (await tool.execute(validArgs)) as Record<string, unknown>;

    expect(first.stored).toBe(true);
    expect(second.stored).toBe(true);
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
  });

  test("different-payload store returns conflict", async () => {
    const backend = atomicInMemoryBackend();
    const tool = unwrapTool(createMemoryStoreTool(backend, TEST_MEMORY_DIR));

    await tool.execute(validArgs);
    const second = (await tool.execute({
      ...validArgs,
      content: "Different content.",
    })) as Record<string, unknown>;

    expect(second.stored).toBe(false);
    expect(second.duplicate).toBeDefined();
  });
});
