import { describe, expect, test } from "bun:test";
import type { FileOpRecord, FileSystemBackend, KoiError, Result } from "@koi/core";
import { chainId, nodeId } from "@koi/core";
import { createInMemorySnapshotChainStore } from "@koi/snapshot-chain-store";
import { rollbackTo } from "./rollback.js";

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

function makeRecord(
  path: string,
  previousContent: string | undefined,
  newContent: string,
): FileOpRecord {
  return {
    callId: `call-${Date.now()}`,
    kind: "write",
    path,
    previousContent,
    newContent,
    turnIndex: 0,
    eventIndex: -1,
    timestamp: Date.now(),
  };
}

const testChainId = chainId("rollback-test");

describe("rollbackTo", () => {
  test("returns NOT_FOUND when chain has no head", async () => {
    const store = createInMemorySnapshotChainStore<FileOpRecord>();
    const backend = createTestBackend();

    const result = await rollbackTo(store, testChainId, nodeId("target"), backend);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("no head");
    }
  });

  test("returns NOT_FOUND when target node not in ancestors", async () => {
    const store = createInMemorySnapshotChainStore<FileOpRecord>();
    const backend = createTestBackend();

    // Add a node to the chain
    await store.put(testChainId, makeRecord("/tmp/a.txt", "old", "new"), []);

    const result = await rollbackTo(store, testChainId, nodeId("nonexistent-node"), backend);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("not found in chain ancestors");
    }
  });

  test("restores file content when rolling back a write", async () => {
    const store = createInMemorySnapshotChainStore<FileOpRecord>();
    const backend = createTestBackend();
    backend.files.set("/tmp/a.txt", "modified");

    // Put root node (the snapshot we will roll back TO)
    const rootResult = await store.put(
      testChainId,
      makeRecord("/tmp/a.txt", "original", "modified"),
      [],
    );
    expect(rootResult.ok).toBe(true);
    if (!rootResult.ok) return;
    const rootNodeId = rootResult.value?.nodeId;
    expect(rootNodeId).toBeDefined();
    if (rootNodeId === undefined) return;

    // Put second node (the change we want to undo)
    await store.put(testChainId, makeRecord("/tmp/a.txt", "modified", "further-modified"), [
      rootNodeId,
    ]);
    backend.files.set("/tmp/a.txt", "further-modified");

    // Rollback to root node
    const result = await rollbackTo(store, testChainId, rootNodeId, backend);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(1);
    }
    expect(backend.files.get("/tmp/a.txt")).toBe("modified");
  });

  test("skips delete ops (best-effort rollback)", async () => {
    const store = createInMemorySnapshotChainStore<FileOpRecord>();
    const backend = createTestBackend();

    // Root node
    const rootResult = await store.put(
      testChainId,
      makeRecord("/tmp/keep.txt", "existing", "changed"),
      [],
    );
    expect(rootResult.ok).toBe(true);
    if (!rootResult.ok) return;
    const rootNodeId = rootResult.value?.nodeId;
    expect(rootNodeId).toBeDefined();
    if (rootNodeId === undefined) return;

    // Node that created a new file (previousContent = undefined)
    await store.put(testChainId, makeRecord("/tmp/new-file.txt", undefined, "created content"), [
      rootNodeId,
    ]);
    backend.files.set("/tmp/new-file.txt", "created content");

    // Rollback: should skip the delete for new-file.txt, count = 0
    const result = await rollbackTo(store, testChainId, rootNodeId, backend);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Delete ops are skipped, so no ops applied
      expect(result.value).toBe(0);
    }
    // File still exists (can't delete)
    expect(backend.files.has("/tmp/new-file.txt")).toBe(true);
  });

  test("returns INTERNAL error when backend write fails", async () => {
    const store = createInMemorySnapshotChainStore<FileOpRecord>();

    // Create a backend where write always fails
    const failingBackend: FileSystemBackend = {
      name: "failing-fs",
      read: () => ({
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "Not found",
          retryable: false,
        },
      }),
      write: () => ({
        ok: false,
        error: {
          code: "INTERNAL",
          message: "Disk full",
          retryable: false,
        },
      }),
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

    // Root node
    const rootResult = await store.put(
      testChainId,
      makeRecord("/tmp/a.txt", "original", "modified"),
      [],
    );
    expect(rootResult.ok).toBe(true);
    if (!rootResult.ok) return;
    const rootNodeId = rootResult.value?.nodeId;
    expect(rootNodeId).toBeDefined();
    if (rootNodeId === undefined) return;

    // Second node
    await store.put(testChainId, makeRecord("/tmp/a.txt", "modified", "further"), [rootNodeId]);

    const result = await rollbackTo(store, testChainId, rootNodeId, failingBackend);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toContain("Failed to restore");
      expect(result.error.message).toContain("Disk full");
    }
  });

  test("handles multiple files in rollback", async () => {
    const store = createInMemorySnapshotChainStore<FileOpRecord>();
    const backend = createTestBackend();
    backend.files.set("/tmp/a.txt", "modified-a");
    backend.files.set("/tmp/b.txt", "modified-b");

    // Root node
    const rootResult = await store.put(
      testChainId,
      makeRecord("/tmp/a.txt", "original-a", "modified-a"),
      [],
    );
    expect(rootResult.ok).toBe(true);
    if (!rootResult.ok) return;
    const rootNodeId = rootResult.value?.nodeId;
    expect(rootNodeId).toBeDefined();
    if (rootNodeId === undefined) return;

    // Second node for file b
    await store.put(testChainId, makeRecord("/tmp/b.txt", "original-b", "modified-b"), [
      rootNodeId,
    ]);

    const result = await rollbackTo(store, testChainId, rootNodeId, backend);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only the second node is undone (b.txt), root node is the target
      expect(result.value).toBe(1);
    }
    expect(backend.files.get("/tmp/b.txt")).toBe("original-b");
  });
});
