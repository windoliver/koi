import { beforeEach, describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { CycleConfig } from "./config.js";
import { DEFAULT_CYCLE_CONFIG } from "./config.js";
import { runCycle } from "./cycle.js";
import {
  createFailingBroadcastSink,
  createFailingSelectionStrategy,
  createSpyBroadcastSink,
  createSpySelectionStrategy,
  mockProposal,
  resetMockCounter,
} from "./test-helpers.js";
import type { CycleEvent } from "./types.js";
import { proposalId } from "./types.js";

beforeEach(() => {
  resetMockCounter();
});

function makeConfig(overrides?: Partial<CycleConfig>): CycleConfig {
  const { sink } = createSpyBroadcastSink();
  return {
    strategy: createSpySelectionStrategy(),
    sink,
    minProposals: DEFAULT_CYCLE_CONFIG.minProposals,
    maxOutputPerProposal: DEFAULT_CYCLE_CONFIG.maxOutputPerProposal,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("runCycle — happy path", () => {
  test("selects winner and broadcasts", async () => {
    const { sink, broadcasts } = createSpyBroadcastSink();
    const config = makeConfig({ sink });
    const p1 = mockProposal();
    const p2 = mockProposal();

    const result = await runCycle(config, [p1, p2]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.winner.id).toBe(p1.id); // spy picks first
      expect(result.value.allProposals).toHaveLength(2);
      expect(result.value.cycleId).toBeDefined();
      expect(broadcasts).toHaveLength(1);
    }
  });

  test("single proposal auto-selects and broadcasts", async () => {
    const { sink, broadcasts } = createSpyBroadcastSink();
    const config = makeConfig({ sink });
    const solo = mockProposal();

    const result = await runCycle(config, [solo]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.winner.id).toBe(solo.id);
      expect(broadcasts).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Output truncation
// ---------------------------------------------------------------------------

describe("runCycle — output truncation", () => {
  test("truncates output exceeding maxOutputPerProposal", async () => {
    const { sink } = createSpyBroadcastSink();
    const maxLen = 50;
    const config = makeConfig({ sink, maxOutputPerProposal: maxLen });
    const longOutput = "a".repeat(200);
    const p = mockProposal({ output: longOutput });

    const result = await runCycle(config, [p]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // winner output should be truncated to approximately maxLen
      expect(result.value.winner.output.length).toBeLessThanOrEqual(maxLen);
      expect(result.value.winner.output).toContain("[output truncated]");
    }
  });

  test("does not truncate output within limit", async () => {
    const config = makeConfig({ maxOutputPerProposal: 100 });
    const p = mockProposal({ output: "short" });

    const result = await runCycle(config, [p]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.winner.output).toBe("short");
    }
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("runCycle — validation", () => {
  test("returns error for empty proposals", async () => {
    const config = makeConfig();
    const result = await runCycle(config, []);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("proposals");
    }
  });

  test("returns error when proposals < minProposals", async () => {
    const config = makeConfig({ minProposals: 3 });
    const result = await runCycle(config, [mockProposal(), mockProposal()]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("minimum");
    }
  });

  test("returns error for duplicate proposal IDs", async () => {
    const config = makeConfig();
    const p1 = mockProposal({ id: "dup" });
    const p2 = mockProposal({ id: "dup" });

    const result = await runCycle(config, [p1, p2]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("duplicate");
    }
  });
});

// ---------------------------------------------------------------------------
// Abort signal
// ---------------------------------------------------------------------------

describe("runCycle — abort signal", () => {
  test("returns error when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("user cancelled");
    const config = makeConfig({ signal: controller.signal });

    const result = await runCycle(config, [mockProposal()]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.message).toContain("aborted");
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("runCycle — error handling", () => {
  test("returns error when strategy.select fails", async () => {
    const error: KoiError = {
      code: "INTERNAL",
      message: "strategy exploded",
      retryable: RETRYABLE_DEFAULTS.INTERNAL,
    };
    const config = makeConfig({ strategy: createFailingSelectionStrategy(error) });

    const result = await runCycle(config, [mockProposal()]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toContain("strategy exploded");
    }
  });

  test("returns error when strategy.select throws", async () => {
    const config = makeConfig({
      strategy: {
        name: "throwing",
        select: () => {
          throw new Error("unexpected boom");
        },
      },
    });

    const result = await runCycle(config, [mockProposal()]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toContain("Selection failed");
    }
  });

  test("returns error when sink.broadcast throws", async () => {
    const config = makeConfig({
      sink: createFailingBroadcastSink(new Error("sink down")),
    });

    const result = await runCycle(config, [mockProposal()]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toContain("Broadcast failed");
    }
  });
});

// ---------------------------------------------------------------------------
// Event callbacks
// ---------------------------------------------------------------------------

describe("runCycle — onEvent callbacks", () => {
  test("fires events in correct order on success", async () => {
    const events: CycleEvent[] = [];
    const config = makeConfig({ onEvent: (e) => events.push(e) });

    await runCycle(config, [mockProposal()]);

    expect(events).toHaveLength(4);
    expect(events[0]?.kind).toBe("selection_started");
    expect(events[1]?.kind).toBe("winner_selected");
    expect(events[2]?.kind).toBe("broadcast_started");
    expect(events[3]?.kind).toBe("broadcast_complete");
  });

  test("fires selection_started with proposal count", async () => {
    const events: CycleEvent[] = [];
    const config = makeConfig({ onEvent: (e) => events.push(e) });

    await runCycle(config, [mockProposal(), mockProposal(), mockProposal()]);

    const started = events.find((e) => e.kind === "selection_started");
    expect(started).toBeDefined();
    if (started?.kind === "selection_started") {
      expect(started.proposalCount).toBe(3);
    }
  });

  test("fires cycle_error on strategy failure", async () => {
    const events: CycleEvent[] = [];
    const error: KoiError = {
      code: "INTERNAL",
      message: "bad strategy",
      retryable: false,
    };
    const config = makeConfig({
      strategy: createFailingSelectionStrategy(error),
      onEvent: (e) => events.push(e),
    });

    await runCycle(config, [mockProposal()]);

    const errorEvent = events.find((e) => e.kind === "cycle_error");
    expect(errorEvent).toBeDefined();
  });

  test("does not crash when onEvent is undefined", async () => {
    const config = makeConfig({ onEvent: undefined });
    const result = await runCycle(config, [mockProposal()]);
    expect(result.ok).toBe(true);
  });

  test("does not crash when onEvent throws", async () => {
    const config = makeConfig({
      onEvent: () => {
        throw new Error("observer exploded");
      },
    });
    const result = await runCycle(config, [mockProposal()]);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Concurrent calls
// ---------------------------------------------------------------------------

describe("runCycle — concurrency", () => {
  test("concurrent calls do not interfere", async () => {
    const { sink: sink1, broadcasts: b1 } = createSpyBroadcastSink();
    const { sink: sink2, broadcasts: b2 } = createSpyBroadcastSink();
    const config1 = makeConfig({ sink: sink1 });
    const config2 = makeConfig({ sink: sink2 });

    const [r1, r2] = await Promise.all([
      runCycle(config1, [mockProposal({ id: "c1" })]),
      runCycle(config2, [mockProposal({ id: "c2" })]),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(b1).toHaveLength(1);
    expect(b2).toHaveLength(1);
    if (r1.ok) expect(r1.value.winner.id).toBe(proposalId("c1"));
    if (r2.ok) expect(r2.value.winner.id).toBe(proposalId("c2"));
  });
});
