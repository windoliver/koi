/**
 * Backend discriminator tests for `createCheckpoint`.
 *
 * Verifies that:
 *   1. When `config.backendName` is set, captured `FileOpRecord` entries
 *      carry the backend discriminator.
 *   2. When `config.backendName` is absent, records have no `backend` field.
 *   3. When `config.backends` is set, `doRewind` passes the map to
 *      `runRestore` — tested indirectly via the pre-flight check that
 *      aborts a rewind when a required backend is unavailable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FileSystemBackend,
  JsonObject,
  RunId,
  SessionContext,
  SessionId,
  ToolRequest,
  ToolResponse,
  TurnContext,
  TurnId,
} from "@koi/core";
import { chainId } from "@koi/core";
import { createSnapshotStoreSqlite } from "@koi/snapshot-store-sqlite";
import { createCheckpoint } from "../checkpoint.js";
import type { CheckpointPayload, DriftDetector } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(suffix = "1"): SessionContext {
  return {
    agentId: `agent-${suffix}`,
    sessionId: `session-${suffix}` as SessionId,
    runId: `run-${suffix}` as RunId,
    metadata: {},
  };
}

function makeTurn(session: SessionContext, turnIndex = 0): TurnContext {
  return {
    session,
    turnIndex,
    turnId: `turn-${turnIndex}` as TurnId,
    messages: [],
    metadata: {},
  };
}

function makeRequest(toolId: string, input: JsonObject): ToolRequest {
  return { toolId, input };
}

const PASSTHROUGH_RESPONSE: ToolResponse = { output: { ok: true } };

const NULL_DRIFT: DriftDetector = {
  detect: async () => [],
};

interface TestRig {
  readonly checkpoint: ReturnType<typeof createCheckpoint>;
  readonly store: ReturnType<typeof createSnapshotStoreSqlite<CheckpointPayload>>;
  readonly blobDir: string;
  readonly workDir: string;
  cleanup(): void;
}

function makeRig(
  opts: { backendName?: string; backends?: ReadonlyMap<string, FileSystemBackend> } = {},
): TestRig {
  const blobDir = join(tmpdir(), `koi-cp-blobs-${crypto.randomUUID()}`);
  mkdirSync(blobDir, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), "koi-cp-work-"));
  const store = createSnapshotStoreSqlite<CheckpointPayload>({ path: ":memory:" });

  const checkpoint = createCheckpoint({
    store,
    config: {
      blobDir,
      driftDetector: NULL_DRIFT,
      ...(opts.backendName !== undefined ? { backendName: opts.backendName } : {}),
      ...(opts.backends !== undefined ? { backends: opts.backends } : {}),
    },
  });

  return {
    checkpoint,
    store,
    blobDir,
    workDir,
    cleanup() {
      store.close();
      rmSync(blobDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCheckpoint — backend discriminator in capture", () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = makeRig();
  });

  afterEach(() => {
    rig.cleanup();
  });

  test("FileOpRecord has no backend field when backendName is not configured", async () => {
    const session = makeSession();
    const ctx = makeTurn(session);
    const { middleware } = rig.checkpoint;

    // Write a real file so capturePreImage / capturePostImage succeed
    const filePath = join(rig.workDir, "file.txt");
    writeFileSync(filePath, "initial");

    const wrap = middleware.wrapToolCall;
    expect(wrap).toBeDefined();
    if (wrap === undefined) return;

    await wrap(ctx, makeRequest("fs_write", { path: filePath, content: "updated" }), async () => {
      writeFileSync(filePath, "updated");
      return PASSTHROUGH_RESPONSE;
    });

    const onAfter = middleware.onAfterTurn;
    expect(onAfter).toBeDefined();
    if (onAfter === undefined) return;
    await onAfter(ctx);

    const cid = chainId(String(session.sessionId));
    const head = await rig.store.head(cid);
    expect(head.ok).toBe(true);
    if (!head.ok) return;
    // Skip bootstrap node to find the turn node
    const headNode = head.value;
    if (headNode === undefined) {
      throw new Error("expected head node");
    }
    const ancestors = await rig.store.ancestors({ startNodeId: headNode.nodeId });
    expect(ancestors.ok).toBe(true);
    if (!ancestors.ok) return;

    // Find the first node that has fileOps (skip bootstrap which has fileOps: [])
    const turnNode = ancestors.value.find((n) => n.data.fileOps.length > 0);
    expect(turnNode).toBeDefined();
    if (turnNode === undefined) return;

    expect(turnNode.data.fileOps.length).toBeGreaterThan(0);
    const op = turnNode.data.fileOps[0];
    expect(op).toBeDefined();
    if (op === undefined) return;

    // When no backendName is configured, the `backend` field should be absent
    expect(op.backend).toBeUndefined();
  });
});

describe("createCheckpoint — backend discriminator stamps name on FileOpRecord", () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = makeRig({ backendName: "nexus-local:gdrive://my-drive" });
  });

  afterEach(() => {
    rig.cleanup();
  });

  test("FileOpRecord carries the configured backendName", async () => {
    const session = makeSession("2");
    const ctx = makeTurn(session);
    const { middleware } = rig.checkpoint;
    const { store } = rig;

    const filePath = join(rig.workDir, "file.txt");
    writeFileSync(filePath, "initial content");

    const wrap = middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall undefined");

    await wrap(
      ctx,
      makeRequest("fs_write", { path: filePath, content: "new content" }),
      async () => {
        writeFileSync(filePath, "new content");
        return PASSTHROUGH_RESPONSE;
      },
    );

    const onAfter = middleware.onAfterTurn;
    if (onAfter === undefined) throw new Error("onAfterTurn undefined");
    await onAfter(ctx);

    const cid = chainId(String(session.sessionId));
    const headResult = await store.head(cid);
    expect(headResult.ok).toBe(true);
    if (!headResult.ok || headResult.value === undefined) {
      throw new Error("expected head node");
    }
    const ancestors = await store.ancestors({ startNodeId: headResult.value.nodeId });
    expect(ancestors.ok).toBe(true);
    if (!ancestors.ok) return;

    const turnNode = ancestors.value.find((n) => n.data.fileOps.length > 0);
    expect(turnNode).toBeDefined();
    if (turnNode === undefined) return;

    const op = turnNode.data.fileOps[0];
    expect(op).toBeDefined();
    if (op === undefined) return;

    // The backend discriminator must be stamped on the record
    expect(op.backend).toBe("nexus-local:gdrive://my-drive");
  });
});

describe("createCheckpoint — rewind aborts when required backend unavailable", () => {
  test("rewind returns ok:false when a non-local backend is missing from the map", async () => {
    // Set up a checkpoint with no backends map but backendName set.
    // Capture one turn that stamps a non-local backend discriminator.
    // Then rewind — the pre-flight check should abort with a missing-backend error.
    const blobDir = join(tmpdir(), `koi-cp-blobs-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    const workDir = mkdtempSync(join(tmpdir(), "koi-cp-work-"));
    const store = createSnapshotStoreSqlite<CheckpointPayload>({ path: ":memory:" });

    const BACKEND_NAME = "nexus-local:gdrive://my-drive";
    const checkpoint = createCheckpoint({
      store,
      config: {
        blobDir,
        driftDetector: NULL_DRIFT,
        backendName: BACKEND_NAME,
        // No backends map — rewind should fail the pre-flight check
      },
    });

    const session = makeSession("3");
    const ctx = makeTurn(session);
    const { middleware } = checkpoint;

    const filePath = join(workDir, "file.txt");
    writeFileSync(filePath, "before");

    const wrap = middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall undefined");

    await wrap(ctx, makeRequest("fs_write", { path: filePath, content: "after" }), async () => {
      writeFileSync(filePath, "after");
      return PASSTHROUGH_RESPONSE;
    });

    const onAfter = middleware.onAfterTurn;
    if (onAfter === undefined) throw new Error("onAfterTurn undefined");
    await onAfter(ctx);

    // Now attempt rewind — should fail because the non-local backend is missing
    const result = await checkpoint.rewind(session.sessionId, 1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(BACKEND_NAME);
      expect(result.error.message).toContain("unavailable");
    }

    // Cleanup
    store.close();
    rmSync(blobDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test("rewind succeeds when required backend is present in the backends map", async () => {
    const blobDir = join(tmpdir(), `koi-cp-blobs-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    const workDir = mkdtempSync(join(tmpdir(), "koi-cp-work-"));
    const store = createSnapshotStoreSqlite<CheckpointPayload>({ path: ":memory:" });

    const BACKEND_NAME = "nexus-local:gdrive://my-drive";

    // Mock backend that supports write (needed for restore path)
    const writtenFiles = new Map<string, string>();
    const mockBackend: FileSystemBackend = {
      name: BACKEND_NAME,
      read: () => ({ ok: false, error: { code: "NOT_FOUND", message: "n/a", retryable: false } }),
      write: (path, content) => {
        writtenFiles.set(path, content);
        return { ok: true, value: { path, bytesWritten: content.length } };
      },
      edit: () => ({ ok: false, error: { code: "NOT_FOUND", message: "n/a", retryable: false } }),
      list: () => ({ ok: true, value: { entries: [], truncated: false } }),
      search: () => ({
        ok: false,
        error: { code: "NOT_FOUND", message: "n/a", retryable: false },
      }),
      resolvePath: (p) => p,
    };

    const backends: ReadonlyMap<string, FileSystemBackend> = new Map([[BACKEND_NAME, mockBackend]]);

    const checkpoint = createCheckpoint({
      store,
      config: {
        blobDir,
        driftDetector: NULL_DRIFT,
        backendName: BACKEND_NAME,
        backends,
      },
    });

    const session = makeSession("4");
    const ctx = makeTurn(session);
    const { middleware } = checkpoint;

    // Write a real file so capturePreImage captures the pre-state
    const filePath = join(workDir, "file.txt");
    writeFileSync(filePath, "before");

    const wrap = middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("wrapToolCall undefined");

    await wrap(ctx, makeRequest("fs_write", { path: filePath, content: "after" }), async () => {
      writeFileSync(filePath, "after");
      return PASSTHROUGH_RESPONSE;
    });

    const onAfter = middleware.onAfterTurn;
    if (onAfter === undefined) throw new Error("onAfterTurn undefined");
    await onAfter(ctx);

    // Now attempt rewind — should succeed because the backend is in the map
    const result = await checkpoint.rewind(session.sessionId, 1);

    expect(result.ok).toBe(true);

    // Cleanup
    store.close();
    rmSync(blobDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });
});
