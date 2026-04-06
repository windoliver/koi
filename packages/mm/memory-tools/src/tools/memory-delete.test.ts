import { describe, expect, test } from "bun:test";
import {
  atomicInMemoryBackend,
  mockBackend,
  mockError,
  TEST_MEMORY_DIR,
  unwrapTool,
} from "./__test-utils.js";
import { createMemoryDeleteTool } from "./memory-delete.js";

describe("createMemoryDeleteTool", () => {
  test("builds successfully", () => {
    const result = createMemoryDeleteTool(mockBackend(), TEST_MEMORY_DIR);
    expect(result.ok).toBe(true);
  });

  test("tool has correct name with default prefix", () => {
    const tool = unwrapTool(createMemoryDeleteTool(mockBackend(), TEST_MEMORY_DIR));
    expect(tool.descriptor.name).toBe("memory_delete");
  });

  test("tool is sandboxed with filesystem capabilities", () => {
    const tool = unwrapTool(createMemoryDeleteTool(mockBackend(), TEST_MEMORY_DIR));
    expect(tool.policy.sandbox).toBe(true);
    expect(tool.policy.capabilities.filesystem?.read).toContain(TEST_MEMORY_DIR);
    expect(tool.policy.capabilities.filesystem?.write).toContain(TEST_MEMORY_DIR);
  });
});

describe("memory_delete execute", () => {
  test("deletes existing memory (wasPresent: true)", async () => {
    const backend = mockBackend({
      delete: async () => ({ ok: true, value: { wasPresent: true } }),
    });
    const tool = unwrapTool(createMemoryDeleteTool(backend, TEST_MEMORY_DIR));

    const result = (await tool.execute({ id: "del-1" })) as Record<string, unknown>;
    expect(result.deleted).toBe(true);
    expect(result.id).toBe("del-1");
    expect(result.wasPresent).toBe(true);
  });

  test("idempotent: already-absent returns deleted: true with wasPresent: false", async () => {
    const backend = mockBackend({
      delete: async () => ({ ok: true, value: { wasPresent: false } }),
    });
    const tool = unwrapTool(createMemoryDeleteTool(backend, TEST_MEMORY_DIR));

    const result = (await tool.execute({ id: "missing" })) as Record<string, unknown>;
    expect(result.deleted).toBe(true);
    expect(result.wasPresent).toBe(false);
  });

  test("returns validation error for missing id", async () => {
    const tool = unwrapTool(createMemoryDeleteTool(mockBackend(), TEST_MEMORY_DIR));
    const result = (await tool.execute({})) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns validation error for empty id", async () => {
    const tool = unwrapTool(createMemoryDeleteTool(mockBackend(), TEST_MEMORY_DIR));
    const result = (await tool.execute({ id: "" })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("accepts IDs with path-like characters (backend-agnostic)", async () => {
    const backend = mockBackend({
      delete: async () => ({ ok: true, value: { wasPresent: false } }),
    });
    const tool = unwrapTool(createMemoryDeleteTool(backend, TEST_MEMORY_DIR));
    const result = (await tool.execute({ id: "../../etc/passwd" })) as Record<string, unknown>;
    expect(result.deleted).toBe(true);
    expect(result.wasPresent).toBe(false);
  });

  test("rejects oversized id", async () => {
    const tool = unwrapTool(createMemoryDeleteTool(mockBackend(), TEST_MEMORY_DIR));
    const result = (await tool.execute({ id: "a".repeat(600) })) as Record<string, unknown>;
    expect(result.code).toBe("VALIDATION");
  });

  test("returns sanitized error when delete fails", async () => {
    const backend = mockBackend({
      delete: async () => ({ ok: false, error: mockError("EPERM: /var/data") }),
    });
    const tool = unwrapTool(createMemoryDeleteTool(backend, TEST_MEMORY_DIR));

    const result = (await tool.execute({ id: "x" })) as Record<string, unknown>;
    expect(result.code).toBe("INTERNAL");
    expect(result.error).toBe("Failed to delete memory");
  });

  test("returns sanitized error when backend throws", async () => {
    const backend = mockBackend({
      delete: async () => {
        throw new Error("ENOENT: /private/var/data");
      },
    });
    const tool = unwrapTool(createMemoryDeleteTool(backend, TEST_MEMORY_DIR));

    const result = (await tool.execute({ id: "x" })) as Record<string, unknown>;
    expect(result.code).toBe("INTERNAL");
    expect(result.error).toBe("Failed to delete memory");
  });
});

describe("memory_delete idempotency", () => {
  test("repeated delete: both succeed, second has wasPresent: false", async () => {
    const backend = atomicInMemoryBackend();
    // Store a record first
    const storeResult = backend.store({
      name: "to-delete",
      description: "will be deleted",
      type: "user",
      content: "ephemeral",
    });
    const stored = "ok" in storeResult && storeResult.ok ? storeResult.value : undefined;
    expect(stored).toBeDefined();

    const tool = unwrapTool(createMemoryDeleteTool(backend, TEST_MEMORY_DIR));

    const first = (await tool.execute({ id: stored?.id })) as Record<string, unknown>;
    const second = (await tool.execute({ id: stored?.id })) as Record<string, unknown>;

    expect(first.deleted).toBe(true);
    expect(first.wasPresent).toBe(true);
    expect(second.deleted).toBe(true);
    expect(second.wasPresent).toBe(false);
  });

  test("concurrent deletes: both succeed, exactly one has wasPresent: true", async () => {
    const backend = atomicInMemoryBackend();
    const storeResult = backend.store({
      name: "concurrent-delete",
      description: "will be deleted concurrently",
      type: "user",
      content: "ephemeral",
    });
    const stored = "ok" in storeResult && storeResult.ok ? storeResult.value : undefined;
    expect(stored).toBeDefined();

    const tool = unwrapTool(createMemoryDeleteTool(backend, TEST_MEMORY_DIR));

    const results = await Promise.all([
      tool.execute({ id: stored?.id }) as Promise<Record<string, unknown>>,
      tool.execute({ id: stored?.id }) as Promise<Record<string, unknown>>,
    ]);

    expect(results.every((r) => r.deleted === true)).toBe(true);
    const presentCount = results.filter((r) => r.wasPresent === true).length;
    expect(presentCount).toBe(1);
  });
});
