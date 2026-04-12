/**
 * In-flight queue tests — #1625 design review issue 11A.
 *
 * Verifies the contract that rewind requests received during a tool call
 * are queued and only fire when the engine returns to "idle" for the
 * session in question.
 *
 * Tests cover:
 *   - The pure InFlightTracker primitives (enterTool, exitTool, waitForIdle)
 *   - The RewindSerializer per-session ordering and prior-failure tolerance
 *   - End-to-end: rewind requested mid-tool-call fires after wrapToolCall
 *     completes, not before
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject, RunId, SessionContext, SessionId, TurnContext, TurnId } from "@koi/core";
import { createSnapshotStoreSqlite } from "@koi/snapshot-store-sqlite";
import { createCheckpoint } from "../checkpoint.js";
import { createInFlightTracker, createRewindSerializer } from "../in-flight-queue.js";
import type { CheckpointPayload, DriftDetector } from "../types.js";

const NULL_DRIFT: DriftDetector = { detect: async () => [] };

// ---------------------------------------------------------------------------
// Pure InFlightTracker tests
// ---------------------------------------------------------------------------

describe("InFlightTracker", () => {
  test("getState defaults to idle for unknown sessions", () => {
    const t = createInFlightTracker();
    expect(t.getState("unknown" as SessionId)).toBe("idle");
  });

  test("enterTool flips state to tool-running; exitTool flips back to idle", () => {
    const t = createInFlightTracker();
    const sid = "s1" as SessionId;
    t.enterTool(sid);
    expect(t.getState(sid)).toBe("tool-running");
    t.exitTool(sid);
    expect(t.getState(sid)).toBe("idle");
  });

  test("waitForIdle resolves immediately when already idle", async () => {
    const t = createInFlightTracker();
    let fired = false;
    await t.waitForIdle("s1" as SessionId).then(() => {
      fired = true;
    });
    expect(fired).toBe(true);
  });

  test("waitForIdle resolves on the next exitTool when tool-running", async () => {
    const t = createInFlightTracker();
    const sid = "s1" as SessionId;
    t.enterTool(sid);

    let resolved = false;
    const wait = t.waitForIdle(sid).then(() => {
      resolved = true;
    });
    // Microtask checkpoint — should not have resolved yet because we're
    // still in tool-running state.
    await Promise.resolve();
    expect(resolved).toBe(false);

    t.exitTool(sid);
    await wait;
    expect(resolved).toBe(true);
  });

  test("multiple waiters for the same session all resolve on exitTool", async () => {
    const t = createInFlightTracker();
    const sid = "s1" as SessionId;
    t.enterTool(sid);

    const w1 = t.waitForIdle(sid);
    const w2 = t.waitForIdle(sid);
    const w3 = t.waitForIdle(sid);

    t.exitTool(sid);
    await Promise.all([w1, w2, w3]);
    // Reaching here without timeout means all three resolved.
    expect(true).toBe(true);
  });

  test("sessions are isolated — exitTool on one doesn't unblock another", async () => {
    const t = createInFlightTracker();
    const a = "a" as SessionId;
    const b = "b" as SessionId;
    t.enterTool(a);
    t.enterTool(b);

    let aResolved = false;
    const aWait = t.waitForIdle(a).then(() => {
      aResolved = true;
    });

    t.exitTool(b); // does not affect session a
    await Promise.resolve();
    expect(aResolved).toBe(false);

    t.exitTool(a);
    await aWait;
    expect(aResolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RewindSerializer tests
// ---------------------------------------------------------------------------

describe("RewindSerializer", () => {
  test("serializes tasks per session — second task waits for first to settle", async () => {
    const tracker = createInFlightTracker();
    const ser = createRewindSerializer(tracker);
    const sid = "s1" as SessionId;
    const order: string[] = [];

    const r1 = ser.schedule(sid, async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("a-end");
      return "a";
    });
    const r2 = ser.schedule(sid, async () => {
      order.push("b-start");
      return "b";
    });

    await Promise.all([r1, r2]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  test("waits for the engine to be idle before running the task", async () => {
    const tracker = createInFlightTracker();
    const ser = createRewindSerializer(tracker);
    const sid = "s1" as SessionId;

    tracker.enterTool(sid);

    let ran = false;
    const promise = ser.schedule(sid, async () => {
      ran = true;
      return 42;
    });

    // Should not have run yet — engine is in tool-running.
    await Promise.resolve();
    expect(ran).toBe(false);

    tracker.exitTool(sid);
    const result = await promise;
    expect(ran).toBe(true);
    expect(result).toBe(42);
  });

  test("a failing task does not block subsequent tasks for the session", async () => {
    const tracker = createInFlightTracker();
    const ser = createRewindSerializer(tracker);
    const sid = "s1" as SessionId;

    const r1 = ser.schedule(sid, async () => {
      throw new Error("first failed");
    });
    const r2 = ser.schedule(sid, async () => "second-ran");

    await expect(r1).rejects.toThrow("first failed");
    await expect(r2).resolves.toBe("second-ran");
  });

  test("different sessions run independently — no cross-session blocking", async () => {
    const tracker = createInFlightTracker();
    const ser = createRewindSerializer(tracker);
    const a = "a" as SessionId;
    const b = "b" as SessionId;

    tracker.enterTool(a); // a is busy

    let bRan = false;
    const bPromise = ser.schedule(b, async () => {
      bRan = true;
      return "b";
    });
    // b should run immediately because b is idle, even though a is busy.
    await bPromise;
    expect(bRan).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: rewind during a tool call is queued
// ---------------------------------------------------------------------------

describe("rewind queueing through the middleware", () => {
  let blobDir: string;
  let workDir: string;
  let store: ReturnType<typeof createSnapshotStoreSqlite<CheckpointPayload>>;
  const sid = "queue-session" as SessionId;

  beforeEach(() => {
    blobDir = join(tmpdir(), `koi-cp-q-blobs-${crypto.randomUUID()}`);
    mkdirSync(blobDir, { recursive: true });
    workDir = mkdtempSync(join(tmpdir(), "koi-cp-q-work-"));
    store = createSnapshotStoreSqlite<CheckpointPayload>({ path: ":memory:" });
  });

  afterEach(() => {
    store.close();
    rmSync(blobDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  function makeCtx(turnIndex: number): TurnContext {
    const session: SessionContext = {
      agentId: "agent-q",
      sessionId: sid,
      runId: "run-q" as RunId,
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

  test("rewind requested during wrapToolCall fires after the tool completes, not during", async () => {
    const checkpoint = createCheckpoint({
      store,
      config: { blobDir, driftDetector: NULL_DRIFT },
    });

    const path = join(workDir, "queued.txt");

    // Step 1: capture turn 0 with one file write so there's a snapshot
    // for rewind to land on.
    const onAfter = checkpoint.middleware.onAfterTurn;
    const wrap = checkpoint.middleware.wrapToolCall;
    if (onAfter === undefined || wrap === undefined) throw new Error("hooks missing");

    {
      const ctx = makeCtx(0);
      await wrap(
        ctx,
        { toolId: "fs_write", input: { path, content: "v1" } as JsonObject },
        async () => {
          writeFileSync(path, "v1");
          return { output: { ok: true } };
        },
      );
      await onAfter(ctx);
    }

    // Step 2: capture turn 1 with another write — gives us something to undo.
    {
      const ctx = makeCtx(1);
      await wrap(
        ctx,
        { toolId: "fs_write", input: { path, content: "v2" } as JsonObject },
        async () => {
          writeFileSync(path, "v2");
          return { output: { ok: true } };
        },
      );
      await onAfter(ctx);
    }

    // Step 3: simulate a third turn where a tool call is in flight, and
    // a rewind is requested mid-tool-call. The rewind must NOT fire until
    // the tool finishes.
    const events: string[] = [];

    const ctx2 = makeCtx(2);
    let rewindPromise: Promise<unknown> | undefined;
    const toolPromise = wrap(
      ctx2,
      { toolId: "fs_write", input: { path, content: "v3-mid" } as JsonObject },
      async () => {
        events.push("tool-start");
        // While the tool is "running", request a rewind. It should queue.
        rewindPromise = checkpoint.rewind(sid, 1).then((r) => {
          events.push("rewind-fired");
          return r;
        });
        // Give the rewind a chance to run prematurely (it must NOT).
        await new Promise((r) => setTimeout(r, 20));
        events.push("tool-still-running");
        await new Promise((r) => setTimeout(r, 20));
        writeFileSync(path, "v3-mid");
        events.push("tool-end");
        return { output: { ok: true } };
      },
    );

    await toolPromise;
    if (rewindPromise === undefined) throw new Error("rewind never registered");
    await rewindPromise;

    // The order must be: tool-start, tool-still-running (twice possible),
    // tool-end, then rewind-fired. The rewind must NOT have fired between
    // tool-start and tool-end.
    const toolEndIdx = events.indexOf("tool-end");
    const rewindIdx = events.indexOf("rewind-fired");
    expect(toolEndIdx).toBeGreaterThanOrEqual(0);
    expect(rewindIdx).toBeGreaterThanOrEqual(0);
    expect(rewindIdx).toBeGreaterThan(toolEndIdx);
  });

  test("rewind requested while engine is idle fires immediately", async () => {
    const checkpoint = createCheckpoint({
      store,
      config: { blobDir, driftDetector: NULL_DRIFT },
    });

    // Capture two turns first.
    const onAfter = checkpoint.middleware.onAfterTurn;
    const wrap = checkpoint.middleware.wrapToolCall;
    if (onAfter === undefined || wrap === undefined) throw new Error("hooks missing");
    const path = join(workDir, "imm.txt");

    {
      const ctx = makeCtx(0);
      await wrap(
        ctx,
        { toolId: "fs_write", input: { path, content: "v1" } as JsonObject },
        async () => {
          writeFileSync(path, "v1");
          return { output: { ok: true } };
        },
      );
      await onAfter(ctx);
    }
    {
      const ctx = makeCtx(1);
      await wrap(
        ctx,
        { toolId: "fs_write", input: { path, content: "v2" } as JsonObject },
        async () => {
          writeFileSync(path, "v2");
          return { output: { ok: true } };
        },
      );
      await onAfter(ctx);
    }

    // Engine is idle now (no in-flight tool). Rewind should fire promptly.
    const t0 = performance.now();
    const result = await checkpoint.rewind(sid, 1);
    const elapsed = performance.now() - t0;

    expect(result.ok).toBe(true);
    // Generous bound — anything under ~250 ms means we didn't sit waiting.
    expect(elapsed).toBeLessThan(250);
  });
});
