import { describe, expect, test } from "bun:test";
import type {
  FileOpRecord,
  FileSystemBackend,
  KoiError,
  Result,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { chainId } from "@koi/core";
import { createInMemorySnapshotChainStore } from "@koi/snapshot-chain-store";
import { createMockTurnContext, createSpyToolHandler } from "@koi/test-utils";
import { createFsRollbackMiddleware } from "./fs-rollback.js";

/** Simple in-memory FileSystemBackend for testing. */
function createTestBackend(): FileSystemBackend & {
  readonly files: Map<string, string>;
} {
  const files = new Map<string, string>();

  return {
    name: "test-fs",
    files,
    read: (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Not found: ${path}`,
            retryable: false,
          },
        } satisfies Result<never, KoiError>;
      }
      return {
        ok: true,
        value: { content, path, size: content.length },
      };
    },
    write: (path: string, content: string) => {
      files.set(path, content);
      return {
        ok: true,
        value: { path, bytesWritten: content.length },
      };
    },
    edit: () => ({ ok: true, value: { path: "", hunksApplied: 0 } }),
    list: () => ({
      ok: true,
      value: { entries: [], truncated: false },
    }),
    search: () => ({
      ok: true,
      value: { matches: [], truncated: false },
    }),
  };
}

describe("createFsRollbackMiddleware", () => {
  const testChainId = chainId("test-chain");

  test("passes through non-fs tool calls with zero overhead", async () => {
    const store = createInMemorySnapshotChainStore<FileOpRecord>();
    const backend = createTestBackend();
    const handle = createFsRollbackMiddleware({
      store,
      chainId: testChainId,
      backend,
    });

    const spy = createSpyToolHandler({ output: { ok: true } });
    const ctx = createMockTurnContext();
    const request: ToolRequest = {
      toolId: "search_query",
      input: { query: "hello" },
    };

    const response = await handle.middleware.wrapToolCall?.(ctx, request, spy.handler);

    expect(response).toBeDefined();
    expect(response?.output).toEqual({ ok: true });
    expect(spy.calls).toHaveLength(1);

    // No records should be stored
    const records = await handle.getRecords();
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(0);
    }
  });

  test("captures pre-state and records on fs_write", async () => {
    const store = createInMemorySnapshotChainStore<FileOpRecord>();
    const backend = createTestBackend();
    // Pre-populate a file
    backend.files.set("/tmp/test.txt", "original content");

    const handle = createFsRollbackMiddleware({
      store,
      chainId: testChainId,
      backend,
    });

    const ctx = createMockTurnContext({ turnIndex: 3 });

    // The spy handler simulates the fs_write tool by writing to the backend
    const toolHandler = async (req: ToolRequest): Promise<ToolResponse> => {
      const path = req.input.path as string;
      const content = req.input.content as string;
      backend.write(path, content);
      return { output: { ok: true } };
    };

    const request: ToolRequest = {
      toolId: "fs_write",
      input: { path: "/tmp/test.txt", content: "new content" },
    };

    await handle.middleware.wrapToolCall?.(ctx, request, toolHandler);

    // Verify record was stored
    const records = await handle.getRecords();
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      const node = records.value[0];
      expect(node).toBeDefined();
      expect(node?.data.kind).toBe("write");
      expect(node?.data.path).toBe("/tmp/test.txt");
      expect(node?.data.previousContent).toBe("original content");
      expect(node?.data.newContent).toBe("new content");
      expect(node?.data.turnIndex).toBe(3);
    }
  });

  test("captures pre-state and records on fs_edit", async () => {
    const store = createInMemorySnapshotChainStore<FileOpRecord>();
    const backend = createTestBackend();
    backend.files.set("/tmp/code.ts", "const x = 1;");

    const handle = createFsRollbackMiddleware({
      store,
      chainId: testChainId,
      backend,
    });

    const ctx = createMockTurnContext({ turnIndex: 1 });

    const toolHandler = async (req: ToolRequest): Promise<ToolResponse> => {
      const path = req.input.path as string;
      backend.write(path, "const x = 2;");
      return { output: { ok: true } };
    };

    const request: ToolRequest = {
      toolId: "fs_edit",
      input: {
        path: "/tmp/code.ts",
        old_text: "const x = 1;",
        new_text: "const x = 2;",
      },
    };

    await handle.middleware.wrapToolCall?.(ctx, request, toolHandler);

    const records = await handle.getRecords();
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      const node = records.value[0];
      expect(node).toBeDefined();
      expect(node?.data.kind).toBe("edit");
      expect(node?.data.previousContent).toBe("const x = 1;");
      expect(node?.data.newContent).toBe("const x = 2;");
    }
  });

  test("rollbackTo applies compensating ops", async () => {
    const store = createInMemorySnapshotChainStore<FileOpRecord>();
    const backend = createTestBackend();
    backend.files.set("/tmp/a.txt", "original-a");

    const handle = createFsRollbackMiddleware({
      store,
      chainId: testChainId,
      backend,
    });

    const ctx = createMockTurnContext();

    // First write: create a "before" snapshot
    const toolHandler = async (req: ToolRequest): Promise<ToolResponse> => {
      const path = req.input.path as string;
      const content = req.input.content as string;
      backend.write(path, content);
      return { output: { ok: true } };
    };

    // Write 1
    await handle.middleware.wrapToolCall?.(
      ctx,
      {
        toolId: "fs_write",
        input: { path: "/tmp/a.txt", content: "modified-a" },
      },
      toolHandler,
    );

    // Get the first node ID (this is our rollback target)
    const recordsAfterFirst = await handle.getRecords();
    expect(recordsAfterFirst.ok).toBe(true);
    if (!recordsAfterFirst.ok) return;
    const firstNodeId = recordsAfterFirst.value[0]?.nodeId;
    expect(firstNodeId).toBeDefined();
    if (firstNodeId === undefined) return;

    // Write 2 — further modify the file
    await handle.middleware.wrapToolCall?.(
      ctx,
      {
        toolId: "fs_write",
        input: { path: "/tmp/a.txt", content: "modified-again-a" },
      },
      toolHandler,
    );

    // Verify current state
    expect(backend.files.get("/tmp/a.txt")).toBe("modified-again-a");

    // Rollback to the first node — should restore "modified-a" as previous
    // Actually, rolling back TO the first node means undoing everything AFTER
    // the first node. The second write had previousContent "modified-a",
    // so rollback restores "modified-a".
    const rollbackResult = await handle.rollbackTo(firstNodeId);
    expect(rollbackResult.ok).toBe(true);
    if (rollbackResult.ok) {
      expect(rollbackResult.value).toBe(1);
    }
    expect(backend.files.get("/tmp/a.txt")).toBe("modified-a");
  });

  test("custom tool prefix matching", async () => {
    const store = createInMemorySnapshotChainStore<FileOpRecord>();
    const backend = createTestBackend();
    backend.files.set("/workspace/file.txt", "hello");

    const handle = createFsRollbackMiddleware({
      store,
      chainId: testChainId,
      backend,
      toolPrefix: "file",
    });

    const ctx = createMockTurnContext();

    const toolHandler = async (req: ToolRequest): Promise<ToolResponse> => {
      const path = req.input.path as string;
      backend.write(path, "world");
      return { output: { ok: true } };
    };

    // Should NOT match standard fs_write
    const spy = createSpyToolHandler();
    await handle.middleware.wrapToolCall?.(
      ctx,
      {
        toolId: "fs_write",
        input: { path: "/workspace/file.txt", content: "world" },
      },
      spy.handler,
    );

    // No records — fs_write doesn't match "file" prefix
    const recordsAfterFs = await handle.getRecords();
    expect(recordsAfterFs.ok).toBe(true);
    if (recordsAfterFs.ok) {
      expect(recordsAfterFs.value).toHaveLength(0);
    }

    // Should match file_write
    await handle.middleware.wrapToolCall?.(
      ctx,
      {
        toolId: "file_write",
        input: { path: "/workspace/file.txt", content: "world" },
      },
      toolHandler,
    );

    const recordsAfterFile = await handle.getRecords();
    expect(recordsAfterFile.ok).toBe(true);
    if (recordsAfterFile.ok) {
      expect(recordsAfterFile.value).toHaveLength(1);
      expect(recordsAfterFile.value[0]?.data.kind).toBe("write");
    }
  });

  test("getEventIndex is used when provided", async () => {
    const store = createInMemorySnapshotChainStore<FileOpRecord>();
    const backend = createTestBackend();

    let eventCounter = 41;
    const handle = createFsRollbackMiddleware({
      store,
      chainId: testChainId,
      backend,
      getEventIndex: () => eventCounter++,
    });

    const ctx = createMockTurnContext();

    const toolHandler = async (req: ToolRequest): Promise<ToolResponse> => {
      const path = req.input.path as string;
      backend.write(path, "content");
      return { output: { ok: true } };
    };

    await handle.middleware.wrapToolCall?.(
      ctx,
      {
        toolId: "fs_write",
        input: { path: "/tmp/idx.txt", content: "content" },
      },
      toolHandler,
    );

    const records = await handle.getRecords();
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value[0]?.data.eventIndex).toBe(41);
    }
  });

  test("middleware has correct name and priority", () => {
    const store = createInMemorySnapshotChainStore<FileOpRecord>();
    const backend = createTestBackend();
    const handle = createFsRollbackMiddleware({
      store,
      chainId: testChainId,
      backend,
    });

    expect(handle.middleware.name).toBe("fs-rollback");
    expect(handle.middleware.priority).toBe(350);
  });

  test("records rollback entry when tool mutates file then throws", async () => {
    const store = createInMemorySnapshotChainStore<FileOpRecord>();
    const backend = createTestBackend();
    backend.files.set("/tmp/fail.txt", "before");

    const handle = createFsRollbackMiddleware({
      store,
      chainId: testChainId,
      backend,
    });

    const ctx = createMockTurnContext({ turnIndex: 7 });

    // Tool writes to the file then throws
    const throwingHandler = async (req: ToolRequest): Promise<ToolResponse> => {
      const path = req.input.path as string;
      backend.write(path, "partial-mutation");
      throw new Error("tool exploded after mutating file");
    };

    const request: ToolRequest = {
      toolId: "fs_write",
      input: { path: "/tmp/fail.txt", content: "partial-mutation" },
    };

    await expect(handle.middleware.wrapToolCall?.(ctx, request, throwingHandler)).rejects.toThrow(
      "tool exploded after mutating file",
    );

    // Despite the throw, a rollback record should have been stored
    const records = await handle.getRecords();
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      const node = records.value[0];
      expect(node?.data.previousContent).toBe("before");
      expect(node?.data.newContent).toBe("partial-mutation");
      expect(node?.data.turnIndex).toBe(7);
    }
  });

  test("handles store.put failure gracefully on tool success", async () => {
    const backend = createTestBackend();
    backend.files.set("/tmp/put-fail.txt", "original");

    // Create a store that always fails on put
    const failStore = {
      ...createInMemorySnapshotChainStore<FileOpRecord>(),
      put: async () =>
        ({
          ok: false,
          error: { code: "INTERNAL", message: "Store write failed", retryable: false },
        }) as const,
    };

    const handle = createFsRollbackMiddleware({
      store: failStore,
      chainId: testChainId,
      backend,
    });

    const ctx = createMockTurnContext();
    const toolHandler = async (req: ToolRequest): Promise<ToolResponse> => {
      const path = req.input.path as string;
      backend.write(path, "new-content");
      return { output: { ok: true } };
    };

    // Should not throw — store.put failure is non-fatal
    const response = await handle.middleware.wrapToolCall?.(
      ctx,
      { toolId: "fs_write", input: { path: "/tmp/put-fail.txt", content: "new-content" } },
      toolHandler,
    );
    expect(response?.output).toEqual({ ok: true });
  });

  describe("describeCapabilities", () => {
    test("is defined on the middleware", () => {
      const store = createInMemorySnapshotChainStore<FileOpRecord>();
      const backend = createTestBackend();
      const handle = createFsRollbackMiddleware({
        store,
        chainId: testChainId,
        backend,
      });
      expect(handle.middleware.describeCapabilities).toBeDefined();
    });

    test("returns label 'fs-rollback' and description containing 'rollback'", () => {
      const store = createInMemorySnapshotChainStore<FileOpRecord>();
      const backend = createTestBackend();
      const handle = createFsRollbackMiddleware({
        store,
        chainId: testChainId,
        backend,
      });
      const ctx = createMockTurnContext();
      const result = handle.middleware.describeCapabilities?.(ctx);
      expect(result?.label).toBe("fs-rollback");
      expect(result?.description).toContain("rollback");
    });
  });
});
