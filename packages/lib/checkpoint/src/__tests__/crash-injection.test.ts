/**
 * Crash-injection harness — #1625 design review issue 9A.
 *
 * The full crash-injection test for the SnapshotChainStore lives in
 * @koi/snapshot-store-sqlite. This file tests the *checkpoint package's*
 * end of the protocol: the four-step ordered+idempotent restore flow.
 *
 * The harness:
 *   1. Sets up a happy-path session with a few captured turns.
 *   2. Calls `applyCompensatingOps` partially — only the first K ops.
 *   3. Calls `applyCompensatingOps` again with the FULL list.
 *   4. Asserts the final state matches a fresh full-restore.
 *
 * This validates the convergence property: re-running a partial restore
 * lands on the same state as running it once cleanly. Without this
 * property, the soft-fail / retry story collapses.
 *
 * Plus targeted scenarios:
 *   - Re-running a fully-applied restore is a no-op
 *   - Restoring with a missing CAS blob surfaces a clear error (not corruption)
 *   - The chain store rejecting `put` mid-restore leaves filesystem in target
 *     state (the marker put is the LAST step, so we don't have a torn state)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CompensatingOp,
  JsonObject,
  RunId,
  SessionContext,
  SessionId,
  ToolResponse,
  TurnContext,
  TurnId,
} from "@koi/core";
import { createSnapshotStoreSqlite } from "@koi/snapshot-store-sqlite";
import { writeBlobFromFile } from "../cas-store.js";
import { createCheckpoint } from "../checkpoint.js";
import { applyCompensatingOps } from "../compensating-ops.js";
import type { Checkpoint, CheckpointPayload, DriftDetector } from "../types.js";

const NULL_DRIFT: DriftDetector = { detect: async () => [] };
const PASSTHROUGH: ToolResponse = { output: { ok: true } };
const SID = "crash-session" as SessionId;

interface Rig {
  checkpoint: Checkpoint;
  store: ReturnType<typeof createSnapshotStoreSqlite<CheckpointPayload>>;
  workDir: string;
  blobDir: string;
  cleanup(): void;
}

function makeRig(): Rig {
  const blobDir = join(tmpdir(), `koi-cp-crash-blobs-${crypto.randomUUID()}`);
  mkdirSync(blobDir, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), "koi-cp-crash-work-"));
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

function makeCtx(turnIndex: number): TurnContext {
  const session: SessionContext = {
    agentId: "agent-c",
    sessionId: SID,
    runId: "run-c" as RunId,
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
// Convergence harness
// ---------------------------------------------------------------------------

describe("crash-injection convergence", () => {
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

  /**
   * Generate the compensating ops we'd apply for "rewind to turn 0", and
   * return them along with a verifier that asserts the disk state matches
   * the post-restore expectation.
   *
   * Test scenario: 3 turns, each writing to a different file. Rewinding
   * to turn 0 should leave only file A in its original v1 state and
   * delete files B and C.
   */
  async function setupSession(): Promise<readonly CompensatingOp[]> {
    // Turn 0: create a.txt = a-v1
    await fsWrite(rig, makeCtx(0), pathA, "a-v1");
    await endTurn(rig, makeCtx(0));
    // Turn 1: create b.txt = b-v1
    await fsWrite(rig, makeCtx(1), pathB, "b-v1");
    await endTurn(rig, makeCtx(1));
    // Turn 2: create c.txt = c-v1
    await fsWrite(rig, makeCtx(2), pathC, "c-v1");
    await endTurn(rig, makeCtx(2));

    // Manually compute the compensating ops we'd apply for rewind(2).
    // We hand-build them rather than calling the protocol so the test
    // controls partial application precisely.
    return [
      { kind: "delete", path: pathC }, // undo turn 2
      { kind: "delete", path: pathB }, // undo turn 1
    ];
  }

  function assertRewoundToTurn0(): void {
    expect(readFileSync(pathA, "utf8")).toBe("a-v1");
    expect(existsSync(pathB)).toBe(false);
    expect(existsSync(pathC)).toBe(false);
  }

  test("partial apply (1 of 2 ops) then full apply converges", async () => {
    const ops = await setupSession();
    expect(ops.length).toBe(2);

    // Apply only the first op (undo turn 2 — delete c.txt).
    await applyCompensatingOps([ops[0] as CompensatingOp], rig.blobDir);
    expect(existsSync(pathC)).toBe(false);
    expect(existsSync(pathB)).toBe(true); // not yet rewound

    // Re-run the FULL set. The first op is already applied (delete on
    // missing file = idempotent skip); the second proceeds normally.
    await applyCompensatingOps(ops, rig.blobDir);
    assertRewoundToTurn0();
  });

  test("apply all ops twice converges (idempotence under retry)", async () => {
    const ops = await setupSession();

    await applyCompensatingOps(ops, rig.blobDir);
    assertRewoundToTurn0();

    // Re-run identical ops — should be a no-op.
    const second = await applyCompensatingOps(ops, rig.blobDir);
    assertRewoundToTurn0();
    // Every op should report skipped-already-current.
    for (const r of second) {
      expect(r.kind).toBe("skipped-already-current");
    }
  });

  test("missing CAS blob surfaces clearly without corrupting state", async () => {
    // Build a scenario where we need a restore op but the blob is gone.
    // We stage a file in CAS, then delete the blob from disk before
    // attempting the restore.
    const target = join(rig.workDir, "missing-blob.txt");
    writeFileSync(target, "current state — should not be touched");

    const tmpSrc = join(rig.workDir, "src.txt");
    writeFileSync(tmpSrc, "the original we'd restore");
    const hash = await writeBlobFromFile(rig.blobDir, tmpSrc);

    // Now nuke the blob to simulate GC.
    const blobFile = join(rig.blobDir, hash.slice(0, 2), hash);
    unlinkSync(blobFile);

    const ops: CompensatingOp[] = [{ kind: "restore", path: target, contentHash: hash }];
    const results = await applyCompensatingOps(ops, rig.blobDir);

    // Should report skipped-missing-blob, not crash.
    expect(results[0]?.kind).toBe("skipped-missing-blob");
    // The current file is unchanged.
    expect(readFileSync(target, "utf8")).toBe("current state — should not be touched");
  });

  test("re-running restore via the high-level rewind() converges", async () => {
    // Use the actual checkpoint.rewind() API rather than hand-built ops.
    // Run rewind twice — second call should be a no-op success because
    // the head is already the rewind marker.
    await fsWrite(rig, makeCtx(0), pathA, "a-v1");
    await endTurn(rig, makeCtx(0));
    await fsWrite(rig, makeCtx(1), pathA, "a-v2");
    await endTurn(rig, makeCtx(1));

    expect(readFileSync(pathA, "utf8")).toBe("a-v2");

    // First rewind: undo turn 1.
    const r1 = await rig.checkpoint.rewind(SID, 1);
    expect(r1.ok).toBe(true);
    expect(readFileSync(pathA, "utf8")).toBe("a-v1");

    // Second rewind: should be a no-op success because the new head is
    // already a rewind marker pointing at turn 0. The chain has marker
    // → turn 1 → turn 0 in its DAG history, so rewind(0) lands on the
    // marker itself with zero ops to apply.
    const r2 = await rig.checkpoint.rewind(SID, 0);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.turnsRewound).toBe(0);
      expect(r2.opsApplied).toBe(0);
    }
    expect(readFileSync(pathA, "utf8")).toBe("a-v1");
  });

  test("rewind re-application after partial filesystem mutation still converges", async () => {
    // Capture two turns, then partially "corrupt" the filesystem (simulate
    // a crash mid-restore that left some files in the wrong state), then
    // re-run the full rewind. Should converge.
    await fsWrite(rig, makeCtx(0), pathA, "a-v1");
    await fsWrite(rig, makeCtx(0), pathB, "b-v1");
    await endTurn(rig, makeCtx(0));
    await fsWrite(rig, makeCtx(1), pathA, "a-v2");
    await fsWrite(rig, makeCtx(1), pathB, "b-v2");
    await endTurn(rig, makeCtx(1));

    // Partial corruption: revert pathA but leave pathB in v2.
    writeFileSync(pathA, "a-v1");
    expect(readFileSync(pathA, "utf8")).toBe("a-v1");
    expect(readFileSync(pathB, "utf8")).toBe("b-v2");

    // Now run rewind(1) — it should restore pathB to v1 (and leave pathA
    // alone via the skipped-already-current shortcut).
    const result = await rig.checkpoint.rewind(SID, 1);
    expect(result.ok).toBe(true);
    expect(readFileSync(pathA, "utf8")).toBe("a-v1");
    expect(readFileSync(pathB, "utf8")).toBe("b-v1");
  });
});
