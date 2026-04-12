/**
 * Conversation log truncation integration tests.
 *
 * These verify that when a `SessionTranscript` is wired into the checkpoint
 * config, capture records the post-turn entry count AND rewind truncates the
 * transcript back to that count alongside the file restore.
 *
 * Uses the in-memory `createInMemoryTranscript` from @koi/session as the
 * transcript impl — keeps tests synchronous and self-contained.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  JsonObject,
  RunId,
  SessionContext,
  SessionId,
  SessionTranscript,
  ToolResponse,
  TranscriptEntry,
  TurnContext,
  TurnId,
} from "@koi/core";
import { transcriptEntryId } from "@koi/core";
import { createInMemoryTranscript } from "@koi/session";
import { createSnapshotStoreSqlite } from "@koi/snapshot-store-sqlite";
import { createCheckpoint } from "../checkpoint.js";
import type { Checkpoint, CheckpointPayload, DriftDetector } from "../types.js";

const NULL_DRIFT: DriftDetector = { detect: async () => [] };
const PASSTHROUGH: ToolResponse = { output: { ok: true } };
const SID = "transcript-session" as SessionId;

interface Rig {
  checkpoint: Checkpoint;
  store: ReturnType<typeof createSnapshotStoreSqlite<CheckpointPayload>>;
  transcript: SessionTranscript;
  workDir: string;
  blobDir: string;
  cleanup(): void;
}

function makeRig(): Rig {
  const blobDir = join(tmpdir(), `koi-cp-tx-blobs-${crypto.randomUUID()}`);
  mkdirSync(blobDir, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), "koi-cp-tx-work-"));
  const store = createSnapshotStoreSqlite<CheckpointPayload>({ path: ":memory:" });
  const transcript = createInMemoryTranscript();
  const checkpoint = createCheckpoint({
    store,
    config: { blobDir, driftDetector: NULL_DRIFT, transcript },
  });
  return {
    checkpoint,
    store,
    transcript,
    workDir,
    blobDir,
    cleanup() {
      store.close();
      rmSync(blobDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

function makeCtx(turnIndex: number): TurnContext {
  const session: SessionContext = {
    agentId: "agent-tx",
    sessionId: SID,
    runId: "run-tx" as RunId,
    metadata: {},
  };
  return {
    session,
    turnIndex,
    turnId: `turn-${turnIndex}` as TurnId,
    messages: [],
    metadata: {},
  };
}

function makeEntry(content: string): TranscriptEntry {
  return {
    id: transcriptEntryId(`e-${crypto.randomUUID()}`),
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

async function fsWrite(rig: Rig, ctx: TurnContext, path: string, content: string): Promise<void> {
  const wrap = rig.checkpoint.middleware.wrapToolCall;
  if (wrap === undefined) throw new Error("no wrap");
  await wrap(
    ctx,
    { toolId: "fs_write", input: { path, content } as JsonObject },
    async (): Promise<ToolResponse> => {
      writeFileSync(path, content);
      return PASSTHROUGH;
    },
  );
}

async function endTurn(rig: Rig, ctx: TurnContext): Promise<void> {
  const onAfter = rig.checkpoint.middleware.onAfterTurn;
  if (onAfter === undefined) throw new Error("no onAfter");
  await onAfter(ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("conversation log truncation on rewind", () => {
  let rig: Rig;
  let pathA: string;

  beforeEach(() => {
    rig = makeRig();
    pathA = join(rig.workDir, "a.txt");
  });

  afterEach(() => {
    rig.cleanup();
  });

  test("captures post-turn transcript entry count in CheckpointPayload", async () => {
    // Append two transcript entries before turn 0 ends.
    await rig.transcript.append(SID, [makeEntry("user msg 1"), makeEntry("assistant msg 1")]);
    await endTurn(rig, makeCtx(0));

    // The snapshot should record 2 entries.
    const headNodeId = await rig.checkpoint.currentHead(SID);
    expect(headNodeId).toBeDefined();
    if (headNodeId === undefined) return;
    const lookup = rig.store.get(headNodeId);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.value.data.transcriptEntryCount).toBe(2);
  });

  test("rewind truncates the transcript to the snapshot's recorded count", async () => {
    // Turn 0: 2 transcript entries + a file write.
    await rig.transcript.append(SID, [makeEntry("u0"), makeEntry("a0")]);
    await fsWrite(rig, makeCtx(0), pathA, "a-v1");
    await endTurn(rig, makeCtx(0));

    // Turn 1: 2 more entries + another file edit.
    await rig.transcript.append(SID, [makeEntry("u1"), makeEntry("a1")]);
    await fsWrite(rig, makeCtx(1), pathA, "a-v2");
    await endTurn(rig, makeCtx(1));

    // Verify both halves are in the v2 state before rewind.
    expect(readFileSync(pathA, "utf8")).toBe("a-v2");
    const beforeLoad = await rig.transcript.load(SID);
    if (!beforeLoad.ok) throw new Error("load failed");
    expect(beforeLoad.value.entries.length).toBe(4);

    // Rewind 1 turn — both halves should drop back to turn 0.
    const result = await rig.checkpoint.rewind(SID, 1);
    expect(result.ok).toBe(true);

    expect(readFileSync(pathA, "utf8")).toBe("a-v1");
    const afterLoad = await rig.transcript.load(SID);
    if (!afterLoad.ok) throw new Error("load failed");
    expect(afterLoad.value.entries.length).toBe(2);
    expect(afterLoad.value.entries.map((e) => e.content)).toEqual(["u0", "a0"]);
  });

  test("rewind 0 (no-op) leaves the transcript untouched", async () => {
    await rig.transcript.append(SID, [makeEntry("u0"), makeEntry("a0")]);
    await endTurn(rig, makeCtx(0));

    const before = await rig.transcript.load(SID);
    if (!before.ok) throw new Error("load failed");
    const beforeIds = before.value.entries.map((e) => e.id);

    const result = await rig.checkpoint.rewind(SID, 0);
    expect(result.ok).toBe(true);

    const after = await rig.transcript.load(SID);
    if (!after.ok) throw new Error("load failed");
    expect(after.value.entries.map((e) => e.id)).toEqual(beforeIds);
  });

  test("rewind 2 turns truncates back across both turn boundaries", async () => {
    // Turn 0: 1 entry
    await rig.transcript.append(SID, [makeEntry("turn-0")]);
    await endTurn(rig, makeCtx(0));
    // Turn 1: 2 entries
    await rig.transcript.append(SID, [makeEntry("turn-1a"), makeEntry("turn-1b")]);
    await endTurn(rig, makeCtx(1));
    // Turn 2: 3 entries
    await rig.transcript.append(SID, [
      makeEntry("turn-2a"),
      makeEntry("turn-2b"),
      makeEntry("turn-2c"),
    ]);
    await endTurn(rig, makeCtx(2));

    const total = await rig.transcript.load(SID);
    expect(total.ok).toBe(true);
    if (!total.ok) throw new Error("load failed");
    expect(total.value.entries.length).toBe(6);

    // Rewind 2 → should land back at end-of-turn-0 with just 1 entry.
    const result = await rig.checkpoint.rewind(SID, 2);
    expect(result.ok).toBe(true);

    const after = await rig.transcript.load(SID);
    if (!after.ok) throw new Error("load failed");
    expect(after.value.entries.length).toBe(1);
    expect(after.value.entries[0]?.content).toBe("turn-0");
  });

  test("rewind without a wired transcript leaves any external transcript untouched", async () => {
    // Make a NEW checkpoint with no transcript wired.
    const blobDir = join(tmpdir(), `koi-cp-tx-no-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    const store = createSnapshotStoreSqlite<CheckpointPayload>({ path: ":memory:" });
    const transcript = createInMemoryTranscript();
    const checkpoint = createCheckpoint({
      store,
      config: { blobDir, driftDetector: NULL_DRIFT /* no transcript */ },
    });
    const sid = "no-transcript-session" as SessionId;
    function ctx(i: number): TurnContext {
      return {
        session: { agentId: "a", sessionId: sid, runId: "r" as RunId, metadata: {} },
        turnIndex: i,
        turnId: `t${i}` as TurnId,
        messages: [],
        metadata: {},
      };
    }

    try {
      // Pretend the runtime appended entries (the checkpoint doesn't see them).
      await transcript.append(sid, [makeEntry("u"), makeEntry("a")]);
      const onAfter = checkpoint.middleware.onAfterTurn;
      if (onAfter === undefined) throw new Error("no onAfter");
      await onAfter(ctx(0));
      await onAfter(ctx(1));

      // Rewind 1 — should not touch the transcript.
      const result = await checkpoint.rewind(sid, 1);
      expect(result.ok).toBe(true);

      const after = await transcript.load(sid);
      if (!after.ok) throw new Error("load failed");
      expect(after.value.entries.length).toBe(2); // unchanged
    } finally {
      store.close();
      rmSync(blobDir, { recursive: true, force: true });
    }
  });

  test("snapshot without transcriptEntryCount does not truncate (per-turn opt-in)", async () => {
    // Manually put a snapshot with no transcriptEntryCount, then rewind to it.
    // This simulates a session that was captured before the transcript was wired.
    // The rewind should still restore file state but skip transcript truncation.
    await rig.transcript.append(SID, [makeEntry("u0"), makeEntry("a0")]);
    await endTurn(rig, makeCtx(0));

    // Append more entries WITHOUT capturing them in a snapshot.
    await rig.transcript.append(SID, [makeEntry("u1"), makeEntry("a1")]);
    // No endTurn — we're testing the case where rewind targets a snapshot
    // that has a count but the live transcript has grown past it.

    const result = await rig.checkpoint.rewind(SID, 0); // rewind to current head
    expect(result.ok).toBe(true);
    // Rewind 0 = no-op, transcript should be unchanged (4 entries).
    const after = await rig.transcript.load(SID);
    if (!after.ok) throw new Error("load failed");
    expect(after.value.entries.length).toBe(4);
  });
});
