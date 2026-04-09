/**
 * Checkpoint middleware integration tests.
 *
 * Constructs the middleware directly with a real `@koi/snapshot-store-sqlite`
 * (`:memory:`) and synthetic `TurnContext` / `ToolRequest` objects, then
 * exercises the capture flow end to end.
 *
 * Pattern matches `@koi/middleware-goal`'s test style: direct middleware
 * construction, manual hook invocation, no fake engine.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CapabilityFragment,
  JsonObject,
  KoiMiddleware,
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
import { createCheckpointMiddleware } from "../checkpoint-middleware.js";
import type { CheckpointPayload, DriftDetector } from "../types.js";

// ---------------------------------------------------------------------------
// Test fixtures
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
const passthroughHandler = async (_req: ToolRequest): Promise<ToolResponse> => PASSTHROUGH_RESPONSE;

const NULL_DRIFT: DriftDetector = {
  detect: async () => [],
};

interface TestRig {
  readonly middleware: KoiMiddleware;
  readonly store: ReturnType<typeof createSnapshotStoreSqlite<CheckpointPayload>>;
  readonly blobDir: string;
  readonly workDir: string;
  cleanup(): void;
}

function makeRig(): TestRig {
  const blobDir = join(tmpdir(), `koi-cp-blobs-${crypto.randomUUID()}`);
  mkdirSync(blobDir, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), "koi-cp-work-"));
  const store = createSnapshotStoreSqlite<CheckpointPayload>({ path: ":memory:" });
  const middleware = createCheckpointMiddleware({
    store,
    config: {
      blobDir,
      driftDetector: NULL_DRIFT, // disable git status calls in tests
    },
  });
  return {
    middleware,
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

function expectFn<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected defined value");
  return value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkpoint middleware", () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = makeRig();
  });

  afterEach(() => {
    rig.cleanup();
  });

  test("describeCapabilities returns a label and description", () => {
    const session = makeSession();
    const ctx = makeTurn(session);
    const cap = expectFn(rig.middleware.describeCapabilities(ctx));
    expect((cap as CapabilityFragment).label).toBe("checkpoint");
    expect((cap as CapabilityFragment).description).toContain("fs_edit");
    expect((cap as CapabilityFragment).description).toContain("fs_write");
  });

  test("non-tracked tools pass through with no capture", async () => {
    const session = makeSession();
    const ctx = makeTurn(session);

    const wrap = expectFn(rig.middleware.wrapToolCall);
    const response = await wrap(
      ctx,
      makeRequest("shell_exec", { command: "ls" }),
      passthroughHandler,
    );
    expect(response).toBe(PASSTHROUGH_RESPONSE);

    // No snapshot should be written until onAfterTurn fires.
    const head = rig.store.head(chainId(String(session.sessionId)));
    expect(head.ok).toBe(true);
    if (head.ok) expect(head.value).toBeUndefined();
  });

  test("onAfterTurn writes a snapshot with empty fileOps when no edits happened", async () => {
    const session = makeSession();
    const ctx = makeTurn(session);
    const onAfter = expectFn(rig.middleware.onAfterTurn);

    await onAfter(ctx);

    const head = rig.store.head(chainId(String(session.sessionId)));
    expect(head.ok).toBe(true);
    if (!head.ok) return;
    expect(head.value).toBeDefined();
    expect(head.value?.data.turnIndex).toBe(0);
    expect(head.value?.data.fileOps).toEqual([]);
  });

  test("fs_write that creates a new file is captured as a create record", async () => {
    const session = makeSession();
    const ctx = makeTurn(session);
    const target = join(rig.workDir, "new.txt");
    const wrap = expectFn(rig.middleware.wrapToolCall);
    const onAfter = expectFn(rig.middleware.onAfterTurn);

    await wrap(ctx, makeRequest("fs_write", { path: target, content: "hello" }), async () => {
      // Simulate the write tool actually creating the file.
      writeFileSync(target, "hello");
      return PASSTHROUGH_RESPONSE;
    });
    await onAfter(ctx);

    const head = rig.store.head(chainId(String(session.sessionId)));
    expect(head.ok).toBe(true);
    if (!head.ok || head.value === undefined) return;
    expect(head.value.data.fileOps.length).toBe(1);
    const op = head.value.data.fileOps[0];
    expect(op?.kind).toBe("create");
    if (op?.kind === "create") {
      expect(op.path).toBe(target);
      expect(op.postContentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test("fs_edit that modifies content is captured as an edit record", async () => {
    const session = makeSession();
    const ctx = makeTurn(session);
    const target = join(rig.workDir, "existing.txt");
    writeFileSync(target, "original");
    const wrap = expectFn(rig.middleware.wrapToolCall);
    const onAfter = expectFn(rig.middleware.onAfterTurn);

    await wrap(
      ctx,
      makeRequest("fs_edit", { path: target, edits: [{ oldText: "original", newText: "edited" }] }),
      async () => {
        writeFileSync(target, "edited");
        return PASSTHROUGH_RESPONSE;
      },
    );
    await onAfter(ctx);

    const head = rig.store.head(chainId(String(session.sessionId)));
    if (!head.ok || head.value === undefined) throw new Error("no head");
    const ops = head.value.data.fileOps;
    expect(ops.length).toBe(1);
    expect(ops[0]?.kind).toBe("edit");
    if (ops[0]?.kind === "edit") {
      expect(ops[0].preContentHash).not.toBe(ops[0].postContentHash);
    }
  });

  test("a no-op tool call (file unchanged) does NOT produce a record", async () => {
    const session = makeSession();
    const ctx = makeTurn(session);
    const target = join(rig.workDir, "stable.txt");
    writeFileSync(target, "stable");
    const wrap = expectFn(rig.middleware.wrapToolCall);
    const onAfter = expectFn(rig.middleware.onAfterTurn);

    await wrap(
      ctx,
      makeRequest("fs_edit", { path: target, edits: [], dryRun: true }),
      async () => PASSTHROUGH_RESPONSE,
    );
    await onAfter(ctx);

    const head = rig.store.head(chainId(String(session.sessionId)));
    if (!head.ok || head.value === undefined) throw new Error("no head");
    expect(head.value.data.fileOps).toEqual([]);
  });

  test("multiple turns build a chain — each turn's snapshot has the previous as its parent", async () => {
    const session = makeSession();
    const onAfter = expectFn(rig.middleware.onAfterTurn);

    await onAfter(makeTurn(session, 0));
    await onAfter(makeTurn(session, 1));
    await onAfter(makeTurn(session, 2));

    const list = rig.store.list(chainId(String(session.sessionId)));
    if (!list.ok) throw new Error("list failed");
    expect(list.value.length).toBe(3);

    // Newest first; turn 2 should have turn 1's nodeId in parentIds.
    const newest = list.value[0];
    const middle = list.value[1];
    const oldest = list.value[2];
    expect(newest?.data.turnIndex).toBe(2);
    expect(oldest?.data.turnIndex).toBe(0);
    expect(newest?.parentIds).toEqual(middle ? [middle.nodeId] : []);
    expect(middle?.parentIds).toEqual(oldest ? [oldest.nodeId] : []);
    expect(oldest?.parentIds).toEqual([]);
  });

  test("two sessions are isolated — each gets its own chain", async () => {
    const a = makeSession("a");
    const b = makeSession("b");
    const onAfter = expectFn(rig.middleware.onAfterTurn);

    await onAfter(makeTurn(a));
    await onAfter(makeTurn(b));
    await onAfter(makeTurn(a, 1));

    const aList = rig.store.list(chainId(String(a.sessionId)));
    const bList = rig.store.list(chainId(String(b.sessionId)));
    if (!aList.ok || !bList.ok) throw new Error("list failed");
    expect(aList.value.length).toBe(2);
    expect(bList.value.length).toBe(1);
  });

  test("snapshot is marked complete in metadata under SNAPSHOT_STATUS_KEY", async () => {
    const session = makeSession();
    const onAfter = expectFn(rig.middleware.onAfterTurn);

    await onAfter(makeTurn(session));

    const head = rig.store.head(chainId(String(session.sessionId)));
    if (!head.ok || head.value === undefined) throw new Error("no head");
    expect(head.value.metadata["koi:snapshot_status"]).toBe("complete");
  });

  test("onSessionEnd clears the session's in-memory state", async () => {
    const session = makeSession();
    const onAfter = expectFn(rig.middleware.onAfterTurn);
    const onEnd = expectFn(rig.middleware.onSessionEnd);

    await onAfter(makeTurn(session));
    await onEnd(session);

    // Without errors — clearing is internal but the next session should
    // still work. We resume the same sessionId and confirm it picks up
    // the existing chain head from the store.
    await onAfter(makeTurn(session, 1));
    const list = rig.store.list(chainId(String(session.sessionId)));
    if (!list.ok) throw new Error("list failed");
    expect(list.value.length).toBe(2);
    // Newest must have the prior node as parent (we re-loaded the head
    // from disk, not from in-memory state).
    expect(list.value[0]?.parentIds.length).toBe(1);
  });

  test("end-of-turn snapshot includes the captured file content in CAS", async () => {
    const session = makeSession();
    const ctx = makeTurn(session);
    const target = join(rig.workDir, "verify.txt");
    const wrap = expectFn(rig.middleware.wrapToolCall);
    const onAfter = expectFn(rig.middleware.onAfterTurn);

    await wrap(
      ctx,
      makeRequest("fs_write", { path: target, content: "verify content" }),
      async () => {
        writeFileSync(target, "verify content");
        return PASSTHROUGH_RESPONSE;
      },
    );
    await onAfter(ctx);

    // The recorded postContentHash should resolve to a real blob in CAS.
    const head = rig.store.head(chainId(String(session.sessionId)));
    if (!head.ok || head.value === undefined) throw new Error("no head");
    const op = head.value.data.fileOps[0];
    if (op?.kind !== "create") throw new Error("expected create");
    const blobFile = join(rig.blobDir, op.postContentHash.slice(0, 2), op.postContentHash);
    const bytes = readFileSync(blobFile, "utf8");
    expect(bytes).toBe("verify content");
  });
});
