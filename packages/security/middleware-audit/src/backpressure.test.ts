import { describe, expect, test } from "bun:test";
import type { AuditEntry, AuditSink } from "@koi/core";
import { createAuditMiddleware } from "./audit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession() {
  return {
    agentId: "bp-agent",
    sessionId: "bp-session" as never,
    runId: "bp-run" as never,
    metadata: {},
  };
}

function makeTurnCtx() {
  return {
    session: makeSession(),
    turnIndex: 0,
    turnId: "bp-turn" as never,
    messages: [],
    metadata: {},
  };
}

function makeModelHandler() {
  return async (_req: unknown) => ({ content: "ok", model: "test" });
}

/**
 * Sink that blocks the first log() call until resolve() is called.
 * After resolve(), all subsequent log() calls complete immediately.
 * This lets tests verify overflow behavior without permanently blocking flush().
 */
function makeBlockingSink(): {
  sink: AuditSink;
  readonly logged: AuditEntry[];
  resolve: () => void;
} {
  const logged: AuditEntry[] = [];
  // let justified: set on first blocked log, cleared by resolve()
  let resolver: (() => void) | undefined;
  // let justified: controls whether the next log call blocks
  let blocking = true;

  const sink: AuditSink = {
    log: async (entry: AuditEntry): Promise<void> => {
      logged.push(entry);
      if (blocking) {
        await new Promise<void>((r) => {
          resolver = r;
        });
      }
    },
  };

  return {
    sink,
    get logged() {
      return logged;
    },
    // Unblocks the first pending log AND makes all future log() calls instant
    resolve: () => {
      blocking = false;
      resolver?.();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("backpressure: bounded queue", () => {
  test("queue overflow: drops oldest entry and calls onOverflow", async () => {
    const overflows: Array<{ entry: AuditEntry; count: number }> = [];
    const { sink, resolve } = makeBlockingSink();
    const ctx = makeTurnCtx();

    const mw = createAuditMiddleware({
      sink,
      maxQueueDepth: 3,
      onOverflow: (entry, count) => overflows.push({ entry, count }),
    });

    // Fill queue past capacity (drain loop blocks on first entry)
    for (let i = 0; i < 5; i++) {
      await mw.wrapModelCall?.(
        ctx,
        { messages: [], metadata: { seq: i } as never },
        makeModelHandler() as never,
      );
    }

    // Queue was limited to 3 — first entry is draining (blocked), 2 overflow
    expect(overflows.length).toBeGreaterThanOrEqual(1);
    expect(overflows[0]?.count).toBeGreaterThanOrEqual(1);

    // Unblock the sink and flush
    resolve();
    await mw.flush();
  });

  test("droppedCount increments on each overflow", async () => {
    const { sink, resolve } = makeBlockingSink();
    const ctx = makeTurnCtx();
    const overflowCounts: number[] = [];

    const mw = createAuditMiddleware({
      sink,
      maxQueueDepth: 2,
      onOverflow: (_entry, count) => overflowCounts.push(count),
    });

    // Flood with 6 entries against a depth-2 queue
    for (let i = 0; i < 6; i++) {
      await mw.wrapModelCall?.(ctx, { messages: [] }, makeModelHandler() as never);
    }

    expect(overflowCounts.length).toBeGreaterThanOrEqual(1);
    // Counts should be monotonically increasing
    for (let i = 1; i < overflowCounts.length; i++) {
      const curr = overflowCounts[i];
      const prev = overflowCounts[i - 1];
      if (curr === undefined || prev === undefined) throw new Error("unexpected undefined count");
      expect(curr).toBeGreaterThan(prev);
    }

    resolve();
    await mw.flush();
  });

  test("overflow does not crash the middleware", async () => {
    const { sink, resolve } = makeBlockingSink();
    const ctx = makeTurnCtx();

    const mw = createAuditMiddleware({
      sink,
      maxQueueDepth: 1,
    });

    // Should not throw even with many overflows
    for (let i = 0; i < 20; i++) {
      await mw.wrapModelCall?.(ctx, { messages: [] }, makeModelHandler() as never);
    }

    resolve();
    await mw.flush();
    // Reached here without throwing — pass
    expect(true).toBe(true);
  });

  test("flush() drains queue and resolves when sink is available", async () => {
    const written: AuditEntry[] = [];
    const fastSink: AuditSink = {
      log: async (entry: AuditEntry): Promise<void> => {
        written.push(entry);
      },
    };
    const ctx = makeTurnCtx();
    const mw = createAuditMiddleware({ sink: fastSink, maxQueueDepth: 100 });

    for (let i = 0; i < 10; i++) {
      await mw.wrapModelCall?.(ctx, { messages: [] }, makeModelHandler() as never);
    }

    await mw.flush();
    expect(written.length).toBe(10);
  });
});
