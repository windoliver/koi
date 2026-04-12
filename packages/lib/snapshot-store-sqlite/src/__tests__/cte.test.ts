/**
 * Recursive-CTE correctness tests for the ancestor walk.
 *
 * Per #1625 design review issue 16A, the SQLite store replaces v1's
 * BFS-with-N+1-queries pattern with a single recursive CTE. These tests
 * verify the CTE returns correct results for the four shapes that matter:
 *
 *   - Linear chain (one parent per node)
 *   - Deep chain (depth limit must work even for tall histories)
 *   - DAG diamond (a node reachable via multiple paths must be visited once)
 *   - Depth-bounded walk (maxDepth must clip the result)
 *
 * The CTE uses `UNION` (not `UNION ALL`) for diamond dedup; the tests pin
 * that behavior so a future "optimization" to UNION ALL would break loudly.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChainId, NodeId } from "@koi/core";
import { chainId } from "@koi/core";
import { createSnapshotStoreSqlite, type SqliteSnapshotStore } from "../sqlite-store.js";

function makeTempPath(): string {
  return join(tmpdir(), `koi-snapshot-store-cte-${crypto.randomUUID()}.db`);
}

describe("ancestor CTE", () => {
  let store: SqliteSnapshotStore<string>;
  const c1: ChainId = chainId("chain-cte");

  afterEach(() => {
    store?.close();
  });

  test("linear chain returns nodes in depth order", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const a = store.put(c1, "a", []);
    if (!a.ok || a.value === undefined) throw new Error("a failed");
    const b = store.put(c1, "b", [a.value.nodeId]);
    if (!b.ok || b.value === undefined) throw new Error("b failed");
    const c = store.put(c1, "c", [b.value.nodeId]);
    if (!c.ok || c.value === undefined) throw new Error("c failed");

    const result = store.ancestors({ startNodeId: c.value.nodeId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.map((n) => n.data)).toEqual(["c", "b", "a"]);
  });

  test("deep chain (depth 50) walks to root without N+1", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    let parent: NodeId | undefined;
    let last: NodeId | undefined;
    for (let i = 0; i < 50; i++) {
      const r = store.put(c1, `n${i}`, parent !== undefined ? [parent] : []);
      if (!r.ok || r.value === undefined) throw new Error(`n${i} failed`);
      parent = r.value.nodeId;
      last = r.value.nodeId;
    }
    if (last === undefined) throw new Error("no last");

    const result = store.ancestors({ startNodeId: last });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBe(50);
    // First entry is the start (newest); last entry is the root (oldest).
    expect(result.value[0]?.data).toBe("n49");
    expect(result.value[49]?.data).toBe("n0");
  });

  test("DAG diamond visits the shared ancestor exactly once", () => {
    // Diamond:
    //        bottom
    //         /  \
    //      left  right
    //         \  /
    //         top
    //
    // Walking ancestors from `bottom` should hit `top` exactly once even
    // though there are two paths (via left and via right).
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    const top = store.put(c1, "top", []);
    if (!top.ok || top.value === undefined) throw new Error("top failed");
    const left = store.put(c1, "left", [top.value.nodeId]);
    if (!left.ok || left.value === undefined) throw new Error("left failed");
    const right = store.put(c1, "right", [top.value.nodeId]);
    if (!right.ok || right.value === undefined) throw new Error("right failed");
    const bottom = store.put(c1, "bottom", [left.value.nodeId, right.value.nodeId]);
    if (!bottom.ok || bottom.value === undefined) throw new Error("bottom failed");

    const result = store.ancestors({ startNodeId: bottom.value.nodeId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 4 distinct nodes — top is visited once even though it's reached twice.
    expect(result.value.length).toBe(4);
    const labels = result.value.map((n) => n.data).sort();
    expect(labels).toEqual(["bottom", "left", "right", "top"]);
  });

  test("maxDepth clips the walk", () => {
    store = createSnapshotStoreSqlite<string>({ path: makeTempPath() });
    let parent: NodeId | undefined;
    let last: NodeId | undefined;
    for (let i = 0; i < 10; i++) {
      const r = store.put(c1, `n${i}`, parent !== undefined ? [parent] : []);
      if (!r.ok || r.value === undefined) throw new Error(`n${i} failed`);
      parent = r.value.nodeId;
      last = r.value.nodeId;
    }
    if (last === undefined) throw new Error("no last");

    // maxDepth=3 → start (depth 0) + 3 ancestors (depths 1,2,3) = 4 nodes
    const result = store.ancestors({ startNodeId: last, maxDepth: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(4);
    expect(result.value[0]?.data).toBe("n9");
    expect(result.value[3]?.data).toBe("n6");
  });
});
