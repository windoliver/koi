/**
 * Negative-path tests — failure modes that the store must handle gracefully.
 *
 * Per #1625 design review issue 12A, the store must:
 *   - Return NOT_FOUND for missing nodes
 *   - Return VALIDATION for orphan parent IDs
 *   - Tolerate get() on a chain that doesn't exist
 *   - Tolerate ancestors() on a missing start node
 *   - Reject operations after close()
 *   - Tolerate empty chain_members during prune
 *   - Handle GC when the blob directory does not exist
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChainId } from "@koi/core";
import { chainId, nodeId } from "@koi/core";
import { createSnapshotStoreSqlite, type SqliteSnapshotStore } from "../sqlite-store.js";

function makeTempPath(): string {
  return join(tmpdir(), `koi-snapshot-store-neg-${crypto.randomUUID()}.db`);
}

describe("negative paths", () => {
  let store: SqliteSnapshotStore<string>;

  afterEach(() => {
    store?.close();
  });

  test("get returns NOT_FOUND for missing node", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const result = store.get(nodeId("does-not-exist"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("ancestors returns NOT_FOUND for missing start node", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const result = store.ancestors({ startNodeId: nodeId("missing-root") });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("fork returns NOT_FOUND for missing source node", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const result = store.fork(nodeId("nope"), chainId("c"), "label");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("list on a non-existent chain returns empty array", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const result = store.list(chainId("never-existed"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  test("head on a non-existent chain returns undefined (not an error)", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const result = store.head(chainId("never-existed"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });

  test("prune on an empty chain returns 0 without error", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const result = store.prune(chainId("empty"), { retainCount: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(0);
  });

  test("operations after close return INTERNAL", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    store.close();

    const c: ChainId = chainId("c");
    expect(store.put(c, "x", []).ok).toBe(false);
    expect(store.head(c).ok).toBe(false);
    expect(store.list(c).ok).toBe(false);
    expect(store.get(nodeId("x")).ok).toBe(false);
    expect(store.ancestors({ startNodeId: nodeId("x") }).ok).toBe(false);
    expect(store.fork(nodeId("x"), c, "l").ok).toBe(false);
    expect(store.prune(c, {}).ok).toBe(false);
  });

  test("GC tolerates a missing blob directory (no crash)", () => {
    const missingDir = join(tmpdir(), `koi-missing-${crypto.randomUUID()}`);
    // Intentionally do not create missingDir.
    // Local store variable since this test uses a different payload type.
    const blobStore = createSnapshotStoreSqlite<{ readonly blobs: readonly string[] }>({
      path: makeTempPath(),
      blobDir: missingDir,
      extractBlobRefs: (p) => p.blobs,
    });
    try {
      const c: ChainId = chainId("c");
      blobStore.put(c, { blobs: ["aa".repeat(32)] }, []);
      const result = blobStore.prune(c, { retainCount: 100 });
      expect(result.ok).toBe(true);
    } finally {
      blobStore.close();
      try {
        rmSync(missingDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
