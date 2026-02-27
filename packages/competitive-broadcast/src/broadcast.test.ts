import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createEventBroadcastSink, createInMemoryBroadcastSink } from "./broadcast.js";
import { mockProposal, resetMockCounter } from "./test-helpers.js";
import type { BroadcastResult } from "./types.js";

beforeEach(() => {
  resetMockCounter();
});

function makeBroadcastResult(overrides?: Partial<BroadcastResult>): BroadcastResult {
  const winner = mockProposal({ id: "winner" });
  return {
    winner,
    allProposals: [winner, mockProposal({ id: "loser" })],
    cycleId: "cycle-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createInMemoryBroadcastSink
// ---------------------------------------------------------------------------

describe("createInMemoryBroadcastSink", () => {
  test("delivers to all recipients in parallel", async () => {
    const received: BroadcastResult[] = [];
    const sink = createInMemoryBroadcastSink([
      async (r) => {
        received.push(r);
      },
      async (r) => {
        received.push(r);
      },
    ]);

    const result = makeBroadcastResult();
    const report = await sink.broadcast(result);

    expect(report.delivered).toBe(2);
    expect(report.failed).toBe(0);
    expect(received).toHaveLength(2);
    expect(received[0]).toBe(result);
  });

  test("counts failures but does not throw", async () => {
    const sink = createInMemoryBroadcastSink([
      async () => {
        throw new Error("recipient down");
      },
      async () => {
        /* success */
      },
    ]);

    const report = await sink.broadcast(makeBroadcastResult());

    expect(report.delivered).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.errors).toHaveLength(1);
  });

  test("all recipients fail — failed matches total", async () => {
    const sink = createInMemoryBroadcastSink([
      async () => {
        throw new Error("fail-1");
      },
      async () => {
        throw new Error("fail-2");
      },
    ]);

    const report = await sink.broadcast(makeBroadcastResult());

    expect(report.delivered).toBe(0);
    expect(report.failed).toBe(2);
    expect(report.errors).toHaveLength(2);
  });

  test("zero recipients — returns ok with delivered=0", async () => {
    const sink = createInMemoryBroadcastSink([]);
    const report = await sink.broadcast(makeBroadcastResult());

    expect(report.delivered).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.errors).toBeUndefined();
  });

  test("recipients receive the exact BroadcastResult object", async () => {
    const captured: BroadcastResult[] = [];
    const sink = createInMemoryBroadcastSink([
      async (r) => {
        captured.push(r);
      },
    ]);

    const result = makeBroadcastResult();
    await sink.broadcast(result);

    expect(captured[0]).toBe(result);
  });
});

// ---------------------------------------------------------------------------
// createEventBroadcastSink
// ---------------------------------------------------------------------------

describe("createEventBroadcastSink", () => {
  test("emits broadcast:winner event with the result", async () => {
    const emit = mock(async () => {});
    const eventComponent = { emit, on: () => () => {} };
    const sink = createEventBroadcastSink(eventComponent);

    const result = makeBroadcastResult();
    const report = await sink.broadcast(result);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("broadcast:winner", result);
    expect(report.delivered).toBe(1);
    expect(report.failed).toBe(0);
  });

  test("reports failure when emit throws", async () => {
    const emitError = new Error("event bus down");
    const emit = mock(async () => {
      throw emitError;
    });
    const eventComponent = { emit, on: () => () => {} };
    const sink = createEventBroadcastSink(eventComponent);

    const report = await sink.broadcast(makeBroadcastResult());

    expect(report.delivered).toBe(0);
    expect(report.failed).toBe(1);
    expect(report.errors).toHaveLength(1);
  });
});
