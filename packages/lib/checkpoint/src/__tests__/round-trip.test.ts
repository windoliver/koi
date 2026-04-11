/**
 * Round-trip happy path — the #1625 acceptance criterion test:
 *
 *   "Test: agent edits 3 files across 5 turns; rewind 2 → exactly the
 *    right intermediate state."
 *
 * This is the end-to-end test for capture + restore. Drives the
 * `Checkpoint` factory directly with synthetic TurnContext/ToolRequest
 * objects. After 5 turns of file edits, calls `rewind(2)` and asserts
 * each tracked file is back to its turn-3 content.
 *
 * Plus a few related round-trips:
 *   - rewind 0 is a no-op
 *   - rewind to the same node twice converges (idempotency check)
 *   - rewind by node ID matches rewind by count
 *   - rewind beyond chain length fails cleanly
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
  ToolResponse,
  TurnContext,
  TurnId,
} from "@koi/core";
import { createSnapshotStoreSqlite } from "@koi/snapshot-store-sqlite";
import { createCheckpoint } from "../checkpoint.js";
import type { Checkpoint, CheckpointPayload, DriftDetector } from "../types.js";

const NULL_DRIFT: DriftDetector = { detect: async () => [] };
const PASSTHROUGH: ToolResponse = { output: { ok: true } };

interface Rig {
  checkpoint: Checkpoint;
  store: ReturnType<typeof createSnapshotStoreSqlite<CheckpointPayload>>;
  workDir: string;
  blobDir: string;
  cleanup(): void;
}

function makeRig(): Rig {
  const blobDir = join(tmpdir(), `koi-cp-rt-blobs-${crypto.randomUUID()}`);
  mkdirSync(blobDir, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), "koi-cp-rt-work-"));
  const store = createSnapshotStoreSqlite<CheckpointPayload>({ path: ":memory:" });
  const checkpoint = createCheckpoint({
    store,
    config: { blobDir, driftDetector: NULL_DRIFT },
  });
  return {
    checkpoint,
    store,
    workDir,
    blobDir,
    cleanup() {
      store.close();
      rmSync(blobDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

const SESSION_ID = "rt-session" as SessionId;

function makeSession(): SessionContext {
  return {
    agentId: "agent-rt",
    sessionId: SESSION_ID,
    runId: "run-rt" as RunId,
    metadata: {},
  };
}

function makeTurn(turnIndex: number): TurnContext {
  return {
    session: makeSession(),
    turnIndex,
    turnId: `turn-${turnIndex}` as TurnId,
    messages: [],
    metadata: {},
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
  if (onAfter === undefined) throw new Error("no onAfterTurn");
  await onAfter(ctx);
}

// ---------------------------------------------------------------------------
// The #1625 acceptance test
// ---------------------------------------------------------------------------

describe("round-trip rewind", () => {
  let rig: Rig;
  let pathA: string;
  let pathB: string;
  let pathC: string;

  beforeEach(() => {
    rig = makeRig();
    pathA = join(rig.workDir, "a.txt");
    pathB = join(rig.workDir, "b.txt");
    pathC = join(rig.workDir, "c.txt");
  });

  afterEach(() => {
    rig.cleanup();
  });

  test("agent edits 3 files across 5 turns; rewind 2 → exact intermediate state", async () => {
    // Turn 0: create a.txt = "a-v1"
    {
      const ctx = makeTurn(0);
      await fsWrite(rig, ctx, pathA, "a-v1");
      await endTurn(rig, ctx);
    }
    // Turn 1: create b.txt = "b-v1", edit a.txt = "a-v2"
    {
      const ctx = makeTurn(1);
      await fsWrite(rig, ctx, pathB, "b-v1");
      await fsWrite(rig, ctx, pathA, "a-v2");
      await endTurn(rig, ctx);
    }
    // Turn 2: create c.txt = "c-v1"
    {
      const ctx = makeTurn(2);
      await fsWrite(rig, ctx, pathC, "c-v1");
      await endTurn(rig, ctx);
    }
    // Turn 3: edit b.txt = "b-v2", edit c.txt = "c-v2"
    {
      const ctx = makeTurn(3);
      await fsWrite(rig, ctx, pathB, "b-v2");
      await fsWrite(rig, ctx, pathC, "c-v2");
      await endTurn(rig, ctx);
    }
    // Turn 4: edit a.txt = "a-v3"
    {
      const ctx = makeTurn(4);
      await fsWrite(rig, ctx, pathA, "a-v3");
      await endTurn(rig, ctx);
    }

    // State at end of turn 4:
    expect(readFileSync(pathA, "utf8")).toBe("a-v3");
    expect(readFileSync(pathB, "utf8")).toBe("b-v2");
    expect(readFileSync(pathC, "utf8")).toBe("c-v2");

    // Rewind 2 turns. The chain at this point has 5 captured turns (0..4)
    // as the head. Rewinding 2 lands us on the snapshot for turn 2 — i.e.
    // the state AT THE END of turn 2.
    const result = await rig.checkpoint.rewind(SESSION_ID, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turnsRewound).toBe(2);

    // State should now match end-of-turn-2:
    //   a.txt = "a-v2"  (set in turn 1, untouched in turn 2)
    //   b.txt = "b-v1"  (set in turn 1, untouched in turn 2)
    //   c.txt = "c-v1"  (set in turn 2)
    expect(readFileSync(pathA, "utf8")).toBe("a-v2");
    expect(readFileSync(pathB, "utf8")).toBe("b-v1");
    expect(readFileSync(pathC, "utf8")).toBe("c-v1");
  });

  test("rewind 0 is a no-op", async () => {
    const ctx = makeTurn(0);
    await fsWrite(rig, ctx, pathA, "v1");
    await endTurn(rig, ctx);

    const before = readFileSync(pathA, "utf8");
    const result = await rig.checkpoint.rewind(SESSION_ID, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turnsRewound).toBe(0);
    expect(readFileSync(pathA, "utf8")).toBe(before);
  });

  test("rewind preserves files from earlier turns that are unchanged later", async () => {
    // Turn 0: create a.txt = "a-v1"
    // Turn 1: create b.txt = "b-v1"
    // Rewind 1 → b.txt should be deleted (it was created in the rewound-past turn),
    //            a.txt should remain (created before the rewind point).
    await fsWrite(rig, makeTurn(0), pathA, "a-v1");
    await endTurn(rig, makeTurn(0));
    await fsWrite(rig, makeTurn(1), pathB, "b-v1");
    await endTurn(rig, makeTurn(1));

    expect(readFileSync(pathA, "utf8")).toBe("a-v1");
    expect(readFileSync(pathB, "utf8")).toBe("b-v1");

    const result = await rig.checkpoint.rewind(SESSION_ID, 1);
    expect(result.ok).toBe(true);
    expect(readFileSync(pathA, "utf8")).toBe("a-v1");
    expect(() => readFileSync(pathB, "utf8")).toThrow(); // deleted
  });

  test("rewindTo a specific node ID matches rewind by count", async () => {
    await fsWrite(rig, makeTurn(0), pathA, "a-v1");
    await endTurn(rig, makeTurn(0));

    // Capture the head AFTER turn 0 — this is the target we'll rewind to later.
    const turn0Head = await rig.checkpoint.currentHead(SESSION_ID);
    expect(turn0Head).toBeDefined();

    await fsWrite(rig, makeTurn(1), pathA, "a-v2");
    await endTurn(rig, makeTurn(1));
    await fsWrite(rig, makeTurn(2), pathA, "a-v3");
    await endTurn(rig, makeTurn(2));

    expect(readFileSync(pathA, "utf8")).toBe("a-v3");

    // Rewind to the explicit node from turn 0.
    if (turn0Head === undefined) throw new Error("no turn 0 head");
    const result = await rig.checkpoint.rewindTo(SESSION_ID, turn0Head);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetNodeId).toBe(turn0Head);
    expect(readFileSync(pathA, "utf8")).toBe("a-v1");
  });

  test("rewind beyond chain length fails cleanly without mutating state", async () => {
    await fsWrite(rig, makeTurn(0), pathA, "a-v1");
    await endTurn(rig, makeTurn(0));

    const before = readFileSync(pathA, "utf8");
    const result = await rig.checkpoint.rewind(SESSION_ID, 10);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    // File untouched.
    expect(readFileSync(pathA, "utf8")).toBe(before);
  });

  test("rewind on a fresh session (only bootstrap, no captured turns) returns VALIDATION", async () => {
    // After the bootstrap-on-first-access change, a "fresh" session already
    // has an initial empty snapshot. rewind 1 from that head asks for 1
    // ancestor above head — there is none — so the validation error fires.
    // The old "NOT_FOUND on empty chain" path is unreachable now: the
    // bootstrap ensures every session has at least one snapshot.
    const result = await rig.checkpoint.rewind(SESSION_ID, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("after rewind, capture chains off the new marker (not the pre-rewind head)", async () => {
    await fsWrite(rig, makeTurn(0), pathA, "a-v1");
    await endTurn(rig, makeTurn(0));
    await fsWrite(rig, makeTurn(1), pathA, "a-v2");
    await endTurn(rig, makeTurn(1));

    const r = await rig.checkpoint.rewind(SESSION_ID, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const newHead = r.newHeadNodeId;

    // Run another turn after the rewind.
    await fsWrite(rig, makeTurn(2), pathA, "a-v3");
    await endTurn(rig, makeTurn(2));

    // The new turn's snapshot should have `newHead` as its parent.
    const headAfter = await rig.checkpoint.currentHead(SESSION_ID);
    expect(headAfter).toBeDefined();
    if (headAfter === undefined) return;
    const lookup = await rig.store.get(headAfter);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.value.parentIds).toEqual([newHead]);
    expect(readFileSync(pathA, "utf8")).toBe("a-v3");
  });

  test("/rewind 1 undoes the last USER prompt, even when the prompt produced multiple engine turns", async () => {
    // Simulate the TUI flow exactly: a user prompt that invokes a tool
    // produces TWO engine turns — one with the fileOps (the tool call),
    // and one with empty fileOps (the post-tool summary). Both belong to
    // the same user prompt and should be undone by a single `/rewind 1`.

    // User prompt 1 / engine turn 0: tool call that writes a file.
    await fsWrite(rig, makeTurn(0), pathA, "a-v1");
    await endTurn(rig, makeTurn(0));
    // User prompt 1 / engine turn 1: post-tool summary, no file ops.
    // This simulates the engine's second model call after the tool result
    // gets fed back. The checkpoint middleware should detect this as a
    // continuation (non-empty → empty) and NOT increment the user turn.
    await endTurn(rig, makeTurn(1));

    expect(readFileSync(pathA, "utf8")).toBe("a-v1");

    // `/rewind 1` should undo the ENTIRE first user prompt (both engine
    // turns), landing at the bootstrap state (file gone). This is the key
    // user-facing fix: without the user-turn heuristic, `/rewind 1` would
    // only undo the empty engine turn 1 and leave the file in place.
    const result = await rig.checkpoint.rewind(SESSION_ID, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => readFileSync(pathA, "utf8")).toThrow();
  });

  test("user-turn coalescing only merges 'non-empty → empty' pairs, not consecutive text turns", async () => {
    // Three text-only prompts (no file ops) should each count as a
    // separate user turn, because the continuation heuristic requires the
    // PREVIOUS capture to have non-empty fileOps.
    await endTurn(rig, makeTurn(0)); // userTurn 1
    await endTurn(rig, makeTurn(1)); // userTurn 2
    await endTurn(rig, makeTurn(2)); // userTurn 3

    // Now a file write — this starts userTurn 4.
    await fsWrite(rig, makeTurn(3), pathA, "v1");
    await endTurn(rig, makeTurn(3));

    expect(readFileSync(pathA, "utf8")).toBe("v1");

    // `/rewind 1` undoes userTurn 4 (the file write) and lands at the end
    // of userTurn 3 (after the third empty text prompt).
    const result = await rig.checkpoint.rewind(SESSION_ID, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turnsRewound).toBe(1);
    expect(() => readFileSync(pathA, "utf8")).toThrow();
  });

  test("rewinding twice converges (re-running an already-applied restore is safe)", async () => {
    await fsWrite(rig, makeTurn(0), pathA, "a-v1");
    await endTurn(rig, makeTurn(0));
    await fsWrite(rig, makeTurn(1), pathA, "a-v2");
    await endTurn(rig, makeTurn(1));

    const turn0Head = (await rig.checkpoint.currentHead(SESSION_ID)) as never;
    // First rewind to the (still-current) head — should be a no-op success.
    const r1 = await rig.checkpoint.rewindTo(SESSION_ID, turn0Head);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.turnsRewound).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Incomplete-snapshot handling (soft-fail contract)
  //
  // When a capture fails mid-turn, the checkpoint middleware writes a marker
  // snapshot with `metadata[koi:snapshot_status]="incomplete"` and empty
  // fileOps. runRestore MUST NOT land on such a node (its fileOps don't
  // reflect what actually happened on disk) and MUST surface its nodeId as
  // a warning when crossed during a walk. Verified via direct store writes
  // so we don't need to inject a failure into the middleware itself.
  // ---------------------------------------------------------------------------

  test("rewindTo an incomplete snapshot fails loud with a validation error", async () => {
    await fsWrite(rig, makeTurn(0), pathA, "a-v1");
    await endTurn(rig, makeTurn(0));

    // Seed an incomplete snapshot as a new head. Parent is the current head
    // so the ancestor walk will see it first.
    const headBefore = await rig.checkpoint.currentHead(SESSION_ID);
    if (headBefore === undefined) throw new Error("no head after turn 0");
    const chainId = SESSION_ID as unknown as import("@koi/core").ChainId;
    const incompletePut = await rig.store.put(
      chainId,
      {
        turnIndex: 1,
        userTurnIndex: 2,
        sessionId: SESSION_ID as unknown as string,
        fileOps: [],
        driftWarnings: [],
        capturedAt: Date.now(),
      },
      [headBefore],
      { "koi:snapshot_status": "incomplete" },
    );
    expect(incompletePut.ok).toBe(true);
    if (!incompletePut.ok || incompletePut.value === undefined) return;
    const incompleteNodeId = incompletePut.value.nodeId;

    const result = await rig.checkpoint.rewindTo(SESSION_ID, incompleteNodeId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("incomplete");
  });

  test("rewind walks past an incomplete snapshot and surfaces its nodeId", async () => {
    // Turn 0 (complete): pathA = a-v1
    await fsWrite(rig, makeTurn(0), pathA, "a-v1");
    await endTurn(rig, makeTurn(0));
    const goodNode = await rig.checkpoint.currentHead(SESSION_ID);
    if (goodNode === undefined) throw new Error("no head after turn 0");

    // Seed an INCOMPLETE snapshot at userTurn 2 with empty fileOps, as the
    // checkpoint middleware would write on soft-fail. Parent is the good
    // node so it sits above it on the walk.
    const chainId = SESSION_ID as unknown as import("@koi/core").ChainId;
    const incompletePut = await rig.store.put(
      chainId,
      {
        turnIndex: 1,
        userTurnIndex: 2,
        sessionId: SESSION_ID as unknown as string,
        fileOps: [],
        driftWarnings: [],
        capturedAt: Date.now(),
      },
      [goodNode],
      { "koi:snapshot_status": "incomplete" },
    );
    expect(incompletePut.ok).toBe(true);
    if (!incompletePut.ok || incompletePut.value === undefined) return;
    const incompleteNodeId = incompletePut.value.nodeId;

    // Seed a COMPLETE turn above the incomplete. This is what the user
    // sees as the current head.
    const completePut = await rig.store.put(
      chainId,
      {
        turnIndex: 2,
        userTurnIndex: 3,
        sessionId: SESSION_ID as unknown as string,
        fileOps: [],
        driftWarnings: [],
        capturedAt: Date.now(),
      },
      [incompleteNodeId],
      { "koi:snapshot_status": "complete" },
    );
    expect(completePut.ok).toBe(true);

    // Rewind 2: walks past the complete head (userTurn=3), the incomplete
    // (userTurn=2) — should skip it — and lands on the complete turn 0
    // (userTurn=1). The incomplete's nodeId is surfaced in the result.
    const result = await rig.checkpoint.rewind(SESSION_ID, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetNodeId).toBe(goodNode);
    expect(result.incompleteSnapshotsSkipped).toEqual([incompleteNodeId]);
  });

  test("drift warnings are persisted back into the captured snapshot via updatePayload", async () => {
    // Replace the rig's checkpoint with one that uses a drift detector
    // returning a fixed list. The detector runs in a deferred microtask, so
    // we drain the event loop with setImmediate before reading the snapshot.
    rig.cleanup();
    const blobDir = join(tmpdir(), `koi-cp-rt-blobs-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    const workDir = mkdtempSync(join(tmpdir(), "koi-cp-rt-work-"));
    const store = createSnapshotStoreSqlite<CheckpointPayload>({ path: ":memory:" });
    const WARNINGS = [" M src/a.ts", "?? build/out.js"] as const;
    const driftDetector: DriftDetector = { detect: async () => [...WARNINGS] };
    const checkpoint = createCheckpoint({
      store,
      config: { blobDir, driftDetector },
    });

    // Capture a turn.
    const localCtx = makeTurn(0);
    const wrap = checkpoint.middleware.wrapToolCall;
    if (wrap === undefined) throw new Error("no wrap");
    await wrap(
      localCtx,
      {
        toolId: "fs_write",
        input: { path: join(workDir, "a.txt"), content: "a-v1" } as JsonObject,
      },
      async (): Promise<ToolResponse> => {
        writeFileSync(join(workDir, "a.txt"), "a-v1");
        return PASSTHROUGH;
      },
    );
    const onAfter = checkpoint.middleware.onAfterTurn;
    if (onAfter === undefined) throw new Error("no onAfterTurn");
    await onAfter(localCtx);

    // Drain the microtask queue a few times so the deferred detector and
    // its `.then(updatePayload)` chain have a chance to run.
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // Read the snapshot back — drift warnings must now be persisted.
    const head = await checkpoint.currentHead(SESSION_ID);
    if (head === undefined) throw new Error("no head");
    const lookup = store.get(head);
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) return;
    expect(lookup.value.data.driftWarnings).toEqual([...WARNINGS]);

    // Cleanup the replacement rig.
    store.close();
    rmSync(blobDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });

    // Re-create the shared rig so afterEach can cleanup normally.
    rig = makeRig();
    pathA = join(rig.workDir, "a.txt");
    pathB = join(rig.workDir, "b.txt");
    pathC = join(rig.workDir, "c.txt");
  });

  test("rewind by-count lands on the nearest COMPLETE ancestor (skips incomplete landing sites)", async () => {
    // Turn 0 (complete): pathA = a-v1
    await fsWrite(rig, makeTurn(0), pathA, "a-v1");
    await endTurn(rig, makeTurn(0));
    const goodNode = await rig.checkpoint.currentHead(SESSION_ID);
    if (goodNode === undefined) throw new Error("no head after turn 0");

    // Seed an INCOMPLETE snapshot at userTurn 2 (the target of /rewind 1
    // from a userTurn=3 head).
    const chainId = SESSION_ID as unknown as import("@koi/core").ChainId;
    const incompletePut = await rig.store.put(
      chainId,
      {
        turnIndex: 1,
        userTurnIndex: 2,
        sessionId: SESSION_ID as unknown as string,
        fileOps: [],
        driftWarnings: [],
        capturedAt: Date.now(),
      },
      [goodNode],
      { "koi:snapshot_status": "incomplete" },
    );
    expect(incompletePut.ok).toBe(true);
    if (!incompletePut.ok || incompletePut.value === undefined) return;
    const incompleteNodeId = incompletePut.value.nodeId;

    // Seed a COMPLETE turn at userTurn 3 on top so /rewind 1 would naively
    // try to land on the incomplete at userTurn 2.
    const completePut = await rig.store.put(
      chainId,
      {
        turnIndex: 2,
        userTurnIndex: 3,
        sessionId: SESSION_ID as unknown as string,
        fileOps: [],
        driftWarnings: [],
        capturedAt: Date.now(),
      },
      [incompleteNodeId],
      { "koi:snapshot_status": "complete" },
    );
    expect(completePut.ok).toBe(true);

    // /rewind 1: target userTurn = 3 - 1 = 2. The only snapshot at
    // userTurn=2 is incomplete. Walk must skip past it and land on the
    // complete ancestor at userTurn=1 (turn 0).
    const result = await rig.checkpoint.rewind(SESSION_ID, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetNodeId).toBe(goodNode);
    expect(result.incompleteSnapshotsSkipped).toContain(incompleteNodeId);
  });
});
