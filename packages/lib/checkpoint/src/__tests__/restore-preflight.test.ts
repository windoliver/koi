/**
 * Restore protocol — pre-flight backend availability check tests.
 *
 * Tests cover:
 *   - `runRestore` aborts with a clear error when a required non-local backend
 *     is not present in the `backends` map.
 *   - No filesystem changes are made when the pre-flight check fails (atomicity
 *     guarantee: rewind is all-or-nothing).
 *   - Local ops (backend=undefined or "local") are unaffected by the check.
 *   - When all required backends are present, the restore proceeds normally.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChainId,
  FileDeleteResult,
  FileSystemBackend,
  FileWriteResult,
  NodeId,
  SessionId,
  ToolCallId,
} from "@koi/core";
import { createSnapshotStoreSqlite } from "@koi/snapshot-store-sqlite";
import { writeBlobFromFile } from "../cas-store.js";
import { runRestore } from "../restore-protocol.js";
import type { CheckpointPayload } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Store = ReturnType<typeof createSnapshotStoreSqlite<CheckpointPayload>>;

interface Rig {
  readonly store: Store;
  readonly blobDir: string;
  readonly workDir: string;
  readonly chainId: ChainId;
  cleanup(): void;
}

function makeRig(): Rig {
  const blobDir = join(tmpdir(), `koi-preflight-blobs-${crypto.randomUUID()}`);
  mkdirSync(blobDir, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), "koi-preflight-work-"));
  const store = createSnapshotStoreSqlite<CheckpointPayload>({ path: ":memory:" });
  return {
    store,
    blobDir,
    workDir,
    chainId: "preflight-chain" as ChainId,
    cleanup() {
      store.close();
      rmSync(blobDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

const SESSION_ID = "preflight-session" as SessionId;
const CALL_ID = "call-1" as ToolCallId;

async function putSnapshot(
  rig: Rig,
  parentIds: readonly NodeId[],
  data: Partial<CheckpointPayload>,
): Promise<NodeId> {
  const result = await rig.store.put(
    rig.chainId,
    {
      turnIndex: 0,
      userTurnIndex: 1,
      sessionId: SESSION_ID as unknown as string,
      fileOps: [],
      driftWarnings: [],
      capturedAt: Date.now(),
      ...data,
    },
    [...parentIds],
    { "koi:snapshot_status": "complete" },
  );
  if (!result.ok || result.value === undefined) throw new Error("store.put failed");
  return result.value.nodeId;
}

/**
 * Build a minimal mock FileSystemBackend that records writes.
 */
function makeMockBackend(): {
  backend: FileSystemBackend;
  writtenFiles: Map<string, string>;
  deletedPaths: string[];
} {
  const writtenFiles = new Map<string, string>();
  const deletedPaths: string[] = [];
  const backend: FileSystemBackend = {
    name: "mock-nexus",
    read: () => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "not impl", retryable: false } as never,
    }),
    write: (path: string, content: string) => {
      writtenFiles.set(path, content);
      return { ok: true, value: { path, bytesWritten: content.length } satisfies FileWriteResult };
    },
    edit: () => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "not impl", retryable: false } as never,
    }),
    list: () => ({
      ok: true,
      value: { entries: [], truncated: false },
    }),
    search: () => ({
      ok: false,
      error: { code: "NOT_FOUND", message: "not impl", retryable: false } as never,
    }),
    delete: (path: string) => {
      deletedPaths.push(path);
      return { ok: true, value: { path } satisfies FileDeleteResult };
    },
    resolvePath: (path: string) => path,
  };
  return { backend, writtenFiles, deletedPaths };
}

// ---------------------------------------------------------------------------
// Pre-flight: missing backend aborts before any I/O
// ---------------------------------------------------------------------------

describe("runRestore — pre-flight backend availability check", () => {
  let rig: Rig;

  beforeEach(() => {
    rig = makeRig();
  });

  afterEach(() => {
    rig.cleanup();
  });

  test("aborts with INTERNAL error when required backend is absent from map", async () => {
    // Bootstrap snapshot (userTurnIndex 0).
    const boot = await putSnapshot(rig, [], { userTurnIndex: 0, fileOps: [] });

    // Turn 1: a file op that references a nexus backend.
    const nexusPath = "/nexus/path/file.txt";
    const turn1 = await putSnapshot(rig, [boot], {
      userTurnIndex: 1,
      fileOps: [
        {
          kind: "create",
          callId: CALL_ID,
          path: nexusPath,
          postContentHash: "abc123",
          turnIndex: 1,
          eventIndex: 0,
          timestamp: 0,
          backend: "nexus:my-backend",
        },
      ],
    });
    void turn1; // head is turn1

    const result = await runRestore({
      store: rig.store,
      chainId: rig.chainId,
      blobDir: rig.blobDir,
      target: { kind: "by-count", n: 1 },
      backends: new Map(), // empty — "nexus:my-backend" is not present
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.message).toContain("nexus:my-backend");
    expect(result.error.message).toContain("unavailable");
  });

  test("aborts with INTERNAL error when backends map is undefined and op has non-local backend", async () => {
    // Bootstrap.
    const boot = await putSnapshot(rig, [], { userTurnIndex: 0, fileOps: [] });

    // Turn 1: op with backend set.
    const path = join(rig.workDir, "nexus-file.txt");
    writeFileSync(path, "current");
    const turn1 = await putSnapshot(rig, [boot], {
      userTurnIndex: 1,
      fileOps: [
        {
          kind: "create",
          callId: CALL_ID,
          path,
          postContentHash: "abc",
          turnIndex: 1,
          eventIndex: 0,
          timestamp: 0,
          backend: "nexus:remote",
        },
      ],
    });
    void turn1;

    // No backends map provided — pre-flight should catch the missing backend.
    const result = await runRestore({
      store: rig.store,
      chainId: rig.chainId,
      blobDir: rig.blobDir,
      target: { kind: "by-count", n: 1 },
      // backends not provided
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.message).toContain("nexus:remote");

    // The file on disk must NOT have been touched (no-op guarantee).
    expect(readFileSync(path, "utf8")).toBe("current");
  });

  test("no changes made to filesystem when pre-flight fails (atomicity)", async () => {
    const path = join(rig.workDir, "untouched.txt");
    writeFileSync(path, "original");

    // Bootstrap.
    const boot = await putSnapshot(rig, [], { userTurnIndex: 0, fileOps: [] });

    // Create a blob so local restore would succeed if it ran.
    const src = join(rig.workDir, "src.txt");
    writeFileSync(src, "restored content");
    const hash = await writeBlobFromFile(rig.blobDir, src);

    // Turn 1: a local op + a nexus op (the nexus op causes preflight failure).
    await putSnapshot(rig, [boot], {
      userTurnIndex: 1,
      fileOps: [
        {
          kind: "edit",
          callId: CALL_ID,
          path,
          preContentHash: hash,
          postContentHash: "different",
          turnIndex: 1,
          eventIndex: 0,
          timestamp: 0,
          // No backend = local
        },
        {
          kind: "create",
          callId: CALL_ID,
          path: "/remote/file.txt",
          postContentHash: "xyz",
          turnIndex: 1,
          eventIndex: 1,
          timestamp: 0,
          backend: "nexus:unavailable",
        },
      ],
    });

    const result = await runRestore({
      store: rig.store,
      chainId: rig.chainId,
      blobDir: rig.blobDir,
      target: { kind: "by-count", n: 1 },
      backends: new Map(), // nexus:unavailable not in map
    });

    expect(result.ok).toBe(false);
    // The local file must remain untouched.
    expect(readFileSync(path, "utf8")).toBe("original");
  });

  test("local ops (backend=undefined) pass pre-flight with empty backends map", async () => {
    const path = join(rig.workDir, "local.txt");
    writeFileSync(path, "old content");

    // Bootstrap.
    const boot = await putSnapshot(rig, [], { userTurnIndex: 0, fileOps: [] });

    // Turn 1: local-only op — no backend field.
    await putSnapshot(rig, [boot], {
      userTurnIndex: 1,
      fileOps: [
        {
          kind: "create",
          callId: CALL_ID,
          path,
          postContentHash: "someHash",
          turnIndex: 1,
          eventIndex: 0,
          timestamp: 0,
          // no backend field
        },
      ],
    });

    // Pre-flight should not object — no non-local backend required.
    const result = await runRestore({
      store: rig.store,
      chainId: rig.chainId,
      blobDir: rig.blobDir,
      target: { kind: "by-count", n: 1 },
      backends: new Map(), // empty — OK because ops are all local
    });

    // Restore may fail for other reasons (missing blob) but NOT pre-flight.
    if (!result.ok) {
      expect(result.error.message).not.toContain("unavailable");
    }
  });

  test("local ops with backend='local' pass pre-flight", async () => {
    // Bootstrap.
    const boot = await putSnapshot(rig, [], { userTurnIndex: 0, fileOps: [] });

    // Turn 1: op explicitly tagged backend="local".
    const path = join(rig.workDir, "explicit-local.txt");
    writeFileSync(path, "data");
    await putSnapshot(rig, [boot], {
      userTurnIndex: 1,
      fileOps: [
        {
          kind: "create",
          callId: CALL_ID,
          path,
          postContentHash: "h1",
          turnIndex: 1,
          eventIndex: 0,
          timestamp: 0,
          backend: "local",
        },
      ],
    });

    const result = await runRestore({
      store: rig.store,
      chainId: rig.chainId,
      blobDir: rig.blobDir,
      target: { kind: "by-count", n: 1 },
      backends: new Map(), // empty — "local" ops should not trigger pre-flight
    });

    // Pre-flight passes; restore may fail for other reasons (missing blob).
    if (!result.ok) {
      expect(result.error.message).not.toContain("unavailable");
    }
  });

  test("restore proceeds when all required backends are present", async () => {
    // Bootstrap.
    const boot = await putSnapshot(rig, [], { userTurnIndex: 0, fileOps: [] });

    // Build a real blob for the restore.
    const src = join(rig.workDir, "content.txt");
    writeFileSync(src, "nexus content");
    const hash = await writeBlobFromFile(rig.blobDir, src);

    // Turn 1: a nexus op (edit — restore to preContentHash).
    const remotePath = "/remote/restore-me.txt";
    await putSnapshot(rig, [boot], {
      userTurnIndex: 1,
      fileOps: [
        {
          kind: "edit",
          callId: CALL_ID,
          path: remotePath,
          preContentHash: hash,
          postContentHash: "newer",
          turnIndex: 1,
          eventIndex: 0,
          timestamp: 0,
          backend: "nexus:present",
        },
      ],
    });

    const { backend, writtenFiles } = makeMockBackend();
    const backends = new Map([["nexus:present", backend]]);

    const result = await runRestore({
      store: rig.store,
      chainId: rig.chainId,
      blobDir: rig.blobDir,
      target: { kind: "by-count", n: 1 },
      backends,
    });

    expect(result.ok).toBe(true);
    // Backend.write was called with the restored content.
    expect(writtenFiles.get(remotePath)).toBe("nexus content");
  });

  test("first missing backend name appears in the error message", async () => {
    // Bootstrap.
    const boot = await putSnapshot(rig, [], { userTurnIndex: 0, fileOps: [] });

    // Two different nexus backends, both missing.
    await putSnapshot(rig, [boot], {
      userTurnIndex: 1,
      fileOps: [
        {
          kind: "create",
          callId: CALL_ID,
          path: "/a",
          postContentHash: "h1",
          turnIndex: 1,
          eventIndex: 0,
          timestamp: 0,
          backend: "nexus:alpha",
        },
        {
          kind: "create",
          callId: CALL_ID,
          path: "/b",
          postContentHash: "h2",
          turnIndex: 1,
          eventIndex: 1,
          timestamp: 0,
          backend: "nexus:beta",
        },
      ],
    });

    const result = await runRestore({
      store: rig.store,
      chainId: rig.chainId,
      blobDir: rig.blobDir,
      target: { kind: "by-count", n: 1 },
      backends: new Map(), // neither present
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // At least one backend name is mentioned.
    const msg = result.error.message;
    const mentionsEither = msg.includes("nexus:alpha") || msg.includes("nexus:beta");
    expect(mentionsEither).toBe(true);
  });

  test("rewind by node ID also runs pre-flight check", async () => {
    // Bootstrap.
    const boot = await putSnapshot(rig, [], { userTurnIndex: 0, fileOps: [] });

    // Turn 1: nexus op.
    const turn1 = await putSnapshot(rig, [boot], {
      userTurnIndex: 1,
      fileOps: [
        {
          kind: "create",
          callId: CALL_ID,
          path: "/nexus/x",
          postContentHash: "h1",
          turnIndex: 1,
          eventIndex: 0,
          timestamp: 0,
          backend: "nexus:specific",
        },
      ],
    });
    void turn1;

    const result = await runRestore({
      store: rig.store,
      chainId: rig.chainId,
      blobDir: rig.blobDir,
      target: { kind: "by-node", targetNodeId: boot },
      backends: new Map(), // nexus:specific not present
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("nexus:specific");
  });

  test("zero-turn rewind skips pre-flight (nothing to undo)", async () => {
    // Bootstrap.
    const boot = await putSnapshot(rig, [], { userTurnIndex: 0, fileOps: [] });
    void boot;

    // Zero-rewind: no snapshots to undo, pre-flight should not run.
    const result = await runRestore({
      store: rig.store,
      chainId: rig.chainId,
      blobDir: rig.blobDir,
      target: { kind: "by-count", n: 0 },
      backends: new Map(), // empty — but pre-flight is skipped
    });

    // Zero-rewind always succeeds (turnsRewound=0).
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turnsRewound).toBe(0);
  });
});
