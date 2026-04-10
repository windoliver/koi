/**
 * Compensating-ops unit tests.
 *
 * Tests cover:
 *   - `toCompensating`: each FileOpRecord kind maps to the right inverse
 *   - `computeCompensatingOps`: cross-snapshot ordering by eventIndex DESC
 *   - `applyCompensatingOps`: idempotent restore + delete behavior, including
 *     skipping when the file is already in the target state
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileOpRecord, NodeId, SnapshotNode, ToolCallId } from "@koi/core";
import { writeBlobFromFile } from "../cas-store.js";
import {
  applyCompensatingOps,
  computeCompensatingOps,
  toCompensating,
} from "../compensating-ops.js";
import type { CheckpointPayload } from "../types.js";

function makeBlobDir(): string {
  const dir = join(tmpdir(), `koi-comp-blobs-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeWorkDir(): string {
  return mkdtempSync(join(tmpdir(), "koi-comp-work-"));
}

const callId = "call-1" as ToolCallId;

function fileOp(
  kind: "create" | "edit" | "delete",
  fields: {
    path: string;
    eventIndex: number;
    preContentHash?: string;
    postContentHash?: string;
  },
): FileOpRecord {
  const base = {
    callId,
    path: fields.path,
    turnIndex: 0,
    eventIndex: fields.eventIndex,
    timestamp: 0,
  };
  switch (kind) {
    case "create":
      return { ...base, kind: "create", postContentHash: fields.postContentHash ?? "post" };
    case "edit":
      return {
        ...base,
        kind: "edit",
        preContentHash: fields.preContentHash ?? "pre",
        postContentHash: fields.postContentHash ?? "post",
      };
    case "delete":
      return { ...base, kind: "delete", preContentHash: fields.preContentHash ?? "pre" };
  }
}

function snapshot(fileOps: readonly FileOpRecord[]): SnapshotNode<CheckpointPayload> {
  return {
    nodeId: `node-${crypto.randomUUID()}` as NodeId,
    chainId: "chain-1" as never,
    parentIds: [],
    contentHash: "ignored",
    createdAt: 0,
    metadata: {},
    data: {
      turnIndex: 0,
      userTurnIndex: 1,
      sessionId: "s1",
      fileOps,
      driftWarnings: [],
      capturedAt: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// toCompensating
// ---------------------------------------------------------------------------

describe("toCompensating", () => {
  test("create → delete", () => {
    const op = fileOp("create", { path: "/x", eventIndex: 0, postContentHash: "h1" });
    expect(toCompensating(op)).toEqual({ kind: "delete", path: "/x" });
  });

  test("edit → restore preContentHash", () => {
    const op = fileOp("edit", {
      path: "/x",
      eventIndex: 0,
      preContentHash: "before",
      postContentHash: "after",
    });
    expect(toCompensating(op)).toEqual({ kind: "restore", path: "/x", contentHash: "before" });
  });

  test("delete → restore preContentHash", () => {
    const op = fileOp("delete", { path: "/x", eventIndex: 0, preContentHash: "saved" });
    expect(toCompensating(op)).toEqual({ kind: "restore", path: "/x", contentHash: "saved" });
  });
});

// ---------------------------------------------------------------------------
// computeCompensatingOps
// ---------------------------------------------------------------------------

describe("computeCompensatingOps", () => {
  test("empty input → empty output", () => {
    expect(computeCompensatingOps([])).toEqual([]);
  });

  test("single snapshot — ops produced in reverse eventIndex order", () => {
    const snap = snapshot([
      fileOp("create", { path: "/a", eventIndex: 0 }),
      fileOp("create", { path: "/b", eventIndex: 1 }),
      fileOp("create", { path: "/c", eventIndex: 2 }),
    ]);
    const result = computeCompensatingOps([snap]);
    expect(result.map((r) => r.path)).toEqual(["/c", "/b", "/a"]);
  });

  test("cross-snapshot — ordering uses eventIndex, not snapshot order", () => {
    // Two snapshots, but eventIndex is monotonic across the session.
    const olderSnap = snapshot([
      fileOp("create", { path: "/a", eventIndex: 0 }),
      fileOp("create", { path: "/b", eventIndex: 1 }),
    ]);
    const newerSnap = snapshot([
      fileOp("create", { path: "/c", eventIndex: 2 }),
      fileOp("create", { path: "/d", eventIndex: 3 }),
    ]);
    // Pass them in arbitrary order — output should be sorted by eventIndex DESC.
    const result = computeCompensatingOps([olderSnap, newerSnap]);
    expect(result.map((r) => r.path)).toEqual(["/d", "/c", "/b", "/a"]);
  });

  test("create then edit on same path → undo edit before undo create", () => {
    // File created in op 0, edited in op 1. Undo order: edit first (restore
    // pre-edit content = the original create's post content), then create
    // (delete the file).
    const snap = snapshot([
      fileOp("create", { path: "/x", eventIndex: 0, postContentHash: "v1" }),
      fileOp("edit", {
        path: "/x",
        eventIndex: 1,
        preContentHash: "v1",
        postContentHash: "v2",
      }),
    ]);
    const result = computeCompensatingOps([snap]);
    expect(result.length).toBe(2);
    // First: undo the edit (restore v1)
    expect(result[0]).toEqual({ kind: "restore", path: "/x", contentHash: "v1" });
    // Second: undo the create (delete)
    expect(result[1]).toEqual({ kind: "delete", path: "/x" });
  });

  test("create → edit → delete cycle on same path → all three undone", () => {
    const snap = snapshot([
      fileOp("create", { path: "/x", eventIndex: 0, postContentHash: "v1" }),
      fileOp("edit", {
        path: "/x",
        eventIndex: 1,
        preContentHash: "v1",
        postContentHash: "v2",
      }),
      fileOp("delete", { path: "/x", eventIndex: 2, preContentHash: "v2" }),
    ]);
    const result = computeCompensatingOps([snap]);
    expect(result).toEqual([
      { kind: "restore", path: "/x", contentHash: "v2" }, // undo delete
      { kind: "restore", path: "/x", contentHash: "v1" }, // undo edit
      { kind: "delete", path: "/x" }, // undo create
    ]);
  });

  test("snapshot with no fileOps contributes nothing", () => {
    const empty = snapshot([]);
    const populated = snapshot([fileOp("create", { path: "/x", eventIndex: 0 })]);
    const result = computeCompensatingOps([empty, populated, empty]);
    expect(result.length).toBe(1);
    expect(result[0]?.path).toBe("/x");
  });
});

// ---------------------------------------------------------------------------
// applyCompensatingOps
// ---------------------------------------------------------------------------

describe("applyCompensatingOps", () => {
  let blobDir: string;
  let workDir: string;

  beforeEach(() => {
    blobDir = makeBlobDir();
    workDir = makeWorkDir();
  });

  afterEach(() => {
    rmSync(blobDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test("delete op removes the file (idempotent on missing)", async () => {
    const path = join(workDir, "doomed.txt");
    writeFileSync(path, "x");
    expect(existsSync(path)).toBe(true);

    const r1 = await applyCompensatingOps([{ kind: "delete", path }], blobDir);
    expect(r1[0]?.kind).toBe("applied");
    expect(existsSync(path)).toBe(false);

    // Run again — already deleted, idempotent.
    const r2 = await applyCompensatingOps([{ kind: "delete", path }], blobDir);
    expect(r2[0]?.kind).toBe("skipped-already-current");
  });

  test("restore op writes blob content to the path", async () => {
    const path = join(workDir, "restored.txt");
    // Stage a blob in CAS by writing source then ingesting it.
    const src = join(workDir, "source.txt");
    writeFileSync(src, "original content");
    const hash = await writeBlobFromFile(blobDir, src);

    const r = await applyCompensatingOps([{ kind: "restore", path, contentHash: hash }], blobDir);
    expect(r[0]?.kind).toBe("applied");
    expect(readFileSync(path, "utf8")).toBe("original content");
  });

  test("restore is idempotent — re-applying skips when already current", async () => {
    const path = join(workDir, "stable.txt");
    const src = join(workDir, "source.txt");
    writeFileSync(src, "stable content");
    const hash = await writeBlobFromFile(blobDir, src);

    const first = await applyCompensatingOps(
      [{ kind: "restore", path, contentHash: hash }],
      blobDir,
    );
    expect(first[0]?.kind).toBe("applied");

    const second = await applyCompensatingOps(
      [{ kind: "restore", path, contentHash: hash }],
      blobDir,
    );
    expect(second[0]?.kind).toBe("skipped-already-current");
  });

  test("restore returns skipped-missing-blob when CAS doesn't have the hash", async () => {
    const path = join(workDir, "no-blob.txt");
    const r = await applyCompensatingOps(
      [{ kind: "restore", path, contentHash: "f".repeat(64) }],
      blobDir,
    );
    expect(r[0]?.kind).toBe("skipped-missing-blob");
  });

  test("restore overwrites a file currently holding different content", async () => {
    const path = join(workDir, "edited.txt");
    writeFileSync(path, "current state");

    const src = join(workDir, "src.txt");
    writeFileSync(src, "target state");
    const hash = await writeBlobFromFile(blobDir, src);

    const r = await applyCompensatingOps([{ kind: "restore", path, contentHash: hash }], blobDir);
    expect(r[0]?.kind).toBe("applied");
    expect(readFileSync(path, "utf8")).toBe("target state");
  });

  test("multiple ops applied in order; create-then-edit-undo restores original", async () => {
    const path = join(workDir, "multi.txt");
    writeFileSync(path, "v2"); // current state after a create + edit pair

    const v1Src = join(workDir, "v1-src");
    writeFileSync(v1Src, "v1");
    const hashV1 = await writeBlobFromFile(blobDir, v1Src);

    // Compensating ops for "undo edit, then undo create":
    // 1) restore v1
    // 2) delete file
    const r = await applyCompensatingOps(
      [
        { kind: "restore", path, contentHash: hashV1 },
        { kind: "delete", path },
      ],
      blobDir,
    );
    expect(r[0]?.kind).toBe("applied");
    expect(r[1]?.kind).toBe("applied");
    expect(existsSync(path)).toBe(false);
  });

  test("restore creates parent directories as needed", async () => {
    const nestedPath = join(workDir, "deeply", "nested", "dir", "file.txt");
    const src = join(workDir, "src.txt");
    writeFileSync(src, "nested content");
    const hash = await writeBlobFromFile(blobDir, src);

    const r = await applyCompensatingOps(
      [{ kind: "restore", path: nestedPath, contentHash: hash }],
      blobDir,
    );
    expect(r[0]?.kind).toBe("applied");
    expect(readFileSync(nestedPath, "utf8")).toBe("nested content");
  });
});
