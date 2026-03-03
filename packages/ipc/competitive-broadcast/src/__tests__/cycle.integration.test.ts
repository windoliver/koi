/**
 * Integration tests for competitive broadcast cycles.
 *
 * Tests full selection-broadcast pipelines with real (non-spy) strategies and sinks.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createEventBroadcastSink, createInMemoryBroadcastSink } from "../broadcast.js";
import type { CycleConfig } from "../config.js";
import { DEFAULT_CYCLE_CONFIG } from "../config.js";
import { runCycle } from "../cycle.js";
import {
  createConsensusSelector,
  createFirstWinsSelector,
  createScoredSelector,
} from "../selection.js";
import { mockProposal, resetMockCounter } from "../test-helpers.js";
import type { BroadcastResult, CycleEvent, Vote } from "../types.js";
import { proposalId } from "../types.js";

beforeEach(() => {
  resetMockCounter();
});

// ---------------------------------------------------------------------------
// First-wins + InMemorySink
// ---------------------------------------------------------------------------

describe("first-wins + InMemorySink integration", () => {
  test("correct winner is broadcasted to all recipients", async () => {
    const received: BroadcastResult[] = [];
    const sink = createInMemoryBroadcastSink([
      async (r) => {
        received.push(r);
      },
      async (r) => {
        received.push(r);
      },
    ]);

    const config: CycleConfig = {
      strategy: createFirstWinsSelector(),
      sink,
      minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
      maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
    };

    const early = mockProposal({ id: "early", submittedAt: 1000 });
    const late = mockProposal({ id: "late", submittedAt: 2000 });

    const result = await runCycle(config, [late, early]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.winner.id).toBe(proposalId("early"));
    }
    expect(received).toHaveLength(2);
    expect(received[0]?.winner.id).toBe(proposalId("early"));
    expect(received[1]?.winner.id).toBe(proposalId("early"));
  });
});

// ---------------------------------------------------------------------------
// ScoredSelector + EventSink
// ---------------------------------------------------------------------------

describe("scored + EventSink integration", () => {
  test("winner emitted to event bus", async () => {
    const emit = mock(async () => {});
    const eventComponent = { emit, on: () => () => {} };
    const sink = createEventBroadcastSink(eventComponent);

    const config: CycleConfig = {
      strategy: createScoredSelector(),
      sink,
      minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
      maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
    };

    const low = mockProposal({ id: "low", salience: 0.2 });
    const high = mockProposal({ id: "high", salience: 0.95 });

    const result = await runCycle(config, [low, high]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.winner.id).toBe(proposalId("high"));
    }
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("broadcast:winner", expect.anything());
  });
});

// ---------------------------------------------------------------------------
// ConsensusSelector boundary tests
// ---------------------------------------------------------------------------

describe("consensus + threshold boundary integration", () => {
  test("consensus reached — winner broadcasted", async () => {
    const received: BroadcastResult[] = [];
    const sink = createInMemoryBroadcastSink([
      async (r) => {
        received.push(r);
      },
    ]);

    const config: CycleConfig = {
      strategy: createConsensusSelector({
        threshold: 0.6,
        judge: async (): Promise<readonly Vote[]> => [
          { proposalId: proposalId("strong"), score: 0.8 },
          { proposalId: proposalId("weak"), score: 0.2 },
        ],
      }),
      sink,
      minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
      maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
    };

    const strong = mockProposal({ id: "strong" });
    const weak = mockProposal({ id: "weak" });

    const result = await runCycle(config, [strong, weak]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.winner.id).toBe(proposalId("strong"));
    }
    expect(received).toHaveLength(1);
  });

  test("no consensus reached — returns error, no broadcast", async () => {
    const received: BroadcastResult[] = [];
    const sink = createInMemoryBroadcastSink([
      async (r) => {
        received.push(r);
      },
    ]);

    const config: CycleConfig = {
      strategy: createConsensusSelector({
        threshold: 0.9,
        judge: async (): Promise<readonly Vote[]> => [
          { proposalId: proposalId("a"), score: 0.4 },
          { proposalId: proposalId("b"), score: 0.4 },
        ],
      }),
      sink,
      minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
      maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
    };

    const a = mockProposal({ id: "a" });
    const b = mockProposal({ id: "b" });

    const result = await runCycle(config, [a, b]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("consensus");
    }
    // No broadcast should have happened
    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Mixed: truncation + selection
// ---------------------------------------------------------------------------

describe("truncation + selection integration", () => {
  test("truncated proposals still go through selection correctly", async () => {
    const received: BroadcastResult[] = [];
    const sink = createInMemoryBroadcastSink([
      async (r) => {
        received.push(r);
      },
    ]);

    const config: CycleConfig = {
      strategy: createScoredSelector(),
      sink,
      minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
      maxOutputPerProposal: 50,
    };

    const longLow = mockProposal({ id: "long-low", output: "x".repeat(200), salience: 0.1 });
    const longHigh = mockProposal({ id: "long-high", output: "y".repeat(200), salience: 0.9 });

    const result = await runCycle(config, [longLow, longHigh]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.winner.id).toBe(proposalId("long-high"));
      expect(result.value.winner.output.length).toBeLessThanOrEqual(50);
      expect(result.value.winner.output).toContain("[output truncated]");
    }
  });
});

// ---------------------------------------------------------------------------
// Error path: sink fails
// ---------------------------------------------------------------------------

describe("sink failure integration", () => {
  test("returns error when broadcast throws", async () => {
    const sink = {
      broadcast: async () => {
        throw new Error("network down");
      },
    };

    const config: CycleConfig = {
      strategy: createFirstWinsSelector(),
      sink,
      minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
      maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
    };

    const result = await runCycle(config, [mockProposal()]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });
});

// ---------------------------------------------------------------------------
// Abort mid-cycle
// ---------------------------------------------------------------------------

describe("abort signal integration", () => {
  test("signal aborted between selection and broadcast — winner selected but not broadcast", async () => {
    const received: BroadcastResult[] = [];
    const controller = new AbortController();

    // Strategy that aborts the signal as a side effect of selection
    const abortingStrategy = {
      name: "aborting",
      select: (proposals: readonly import("../types.js").Proposal[]) => {
        controller.abort("user cancelled");
        const first = proposals[0];
        if (first === undefined) {
          return {
            ok: false as const,
            error: { code: "VALIDATION" as const, message: "empty", retryable: false },
          };
        }
        return { ok: true as const, value: first };
      },
    };

    const sink = createInMemoryBroadcastSink([
      async (r) => {
        received.push(r);
      },
    ]);

    const config: CycleConfig = {
      strategy: abortingStrategy,
      sink,
      minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
      maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
      signal: controller.signal,
    };

    const result = await runCycle(config, [mockProposal()]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
    // Broadcast should not have happened
    expect(received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Full event lifecycle
// ---------------------------------------------------------------------------

describe("full event lifecycle integration", () => {
  test("all events fire in correct order with correct data", async () => {
    const events: CycleEvent[] = [];
    const received: BroadcastResult[] = [];
    const sink = createInMemoryBroadcastSink([
      async (r) => {
        received.push(r);
      },
    ]);

    const config: CycleConfig = {
      strategy: createScoredSelector(),
      sink,
      minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
      maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
      onEvent: (e) => events.push(e),
    };

    const p1 = mockProposal({ id: "p1", salience: 0.3 });
    const p2 = mockProposal({ id: "p2", salience: 0.7 });

    await runCycle(config, [p1, p2]);

    expect(events).toHaveLength(4);

    const [e0, e1, e2, e3] = events;
    expect(e0?.kind).toBe("selection_started");
    if (e0?.kind === "selection_started") expect(e0?.proposalCount).toBe(2);

    expect(e1?.kind).toBe("winner_selected");
    if (e1?.kind === "winner_selected") expect(e1?.winner.id).toBe(proposalId("p2"));

    expect(e2?.kind).toBe("broadcast_started");
    if (e2?.kind === "broadcast_started") expect(e2?.winnerId).toBe(proposalId("p2"));

    expect(e3?.kind).toBe("broadcast_complete");
    if (e3?.kind === "broadcast_complete") {
      expect(e3?.report.delivered).toBe(1);
      expect(e3?.report.failed).toBe(0);
    }
  });
});
