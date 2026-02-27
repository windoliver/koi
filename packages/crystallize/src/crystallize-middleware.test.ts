import { describe, expect, mock, test } from "bun:test";
import type { KoiError, SnapshotChainStore, SnapshotNode, TurnContext, TurnTrace } from "@koi/core";
import { chainId, runId, sessionId, turnId } from "@koi/core";
import { createCrystallizeMiddleware } from "./crystallize-middleware.js";
import type { CrystallizationCandidate } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTrace(turnIndex: number, toolIds: readonly string[]): TurnTrace {
  return {
    turnIndex,
    sessionId: sessionId("test-session"),
    agentId: "test-agent",
    events: toolIds.map((toolId, i) => ({
      eventIndex: i,
      turnIndex,
      event: {
        kind: "tool_call" as const,
        toolId,
        callId: `call-${i}` as import("@koi/core").ToolCallId,
        input: {},
        output: {},
        durationMs: 10,
      },
      timestamp: 1000 + i,
    })),
    durationMs: toolIds.length * 10,
  };
}

function wrapAsNode(trace: TurnTrace, index: number): SnapshotNode<TurnTrace> {
  return {
    nodeId: `node-${index}` as import("@koi/core").NodeId,
    chainId: chainId("test-chain"),
    parentIds: [],
    contentHash: `hash-${index}`,
    data: trace,
    createdAt: 1000 + index,
    metadata: {},
  };
}

function createMockStore(traces: readonly TurnTrace[]): SnapshotChainStore<TurnTrace> {
  return {
    list: mock(async () => ({
      ok: true as const,
      value: traces.map((t, i) => wrapAsNode(t, i)),
    })),
    put: mock(async () => ({ ok: true as const, value: undefined })),
    get: mock(async () => ({
      ok: false as const,
      error: { code: "NOT_FOUND", message: "nf", retryable: false } as KoiError,
    })),
    head: mock(async () => ({ ok: true as const, value: undefined })),
    ancestors: mock(async () => ({ ok: true as const, value: [] })),
    fork: mock(async () => ({
      ok: true as const,
      value: { parentNodeId: "n" as import("@koi/core").NodeId, label: "test" },
    })),
    prune: mock(async () => ({ ok: true as const, value: 0 })),
    close: mock(async () => {}),
  } as unknown as SnapshotChainStore<TurnTrace>;
}

function createTurnContext(turnIndex: number): TurnContext {
  const sid = sessionId("test-session");
  const rid = runId("test-run");
  return {
    session: {
      agentId: "test-agent",
      sessionId: sid,
      runId: rid,
      metadata: {},
    },
    turnIndex,
    turnId: turnId(rid, turnIndex),
    messages: [],
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCrystallizeMiddleware", () => {
  test("does not fire callback before minTurnsBeforeAnalysis", async () => {
    const traces = [
      createTrace(0, ["fetch", "parse"]),
      createTrace(1, ["fetch", "parse"]),
      createTrace(2, ["fetch", "parse"]),
    ];
    const store = createMockStore(traces);
    const onDetected = mock((_: readonly CrystallizationCandidate[]) => {});

    const handle = createCrystallizeMiddleware({
      store,
      chainId: chainId("test-chain"),
      minTurnsBeforeAnalysis: 5,
      minOccurrences: 3,
      onCandidatesDetected: onDetected,
      clock: () => 2000,
    });

    // Turn 3 — below minTurns of 5
    await handle.middleware.onAfterTurn?.(createTurnContext(3));
    expect(onDetected).not.toHaveBeenCalled();
  });

  test("fires callback when patterns exceed threshold", async () => {
    const traces = [
      createTrace(0, ["fetch", "parse"]),
      createTrace(1, ["fetch", "parse"]),
      createTrace(2, ["fetch", "parse"]),
      createTrace(3, ["fetch", "parse"]),
      createTrace(4, ["fetch", "parse"]),
    ];
    const store = createMockStore(traces);
    const onDetected = mock((_: readonly CrystallizationCandidate[]) => {});

    const handle = createCrystallizeMiddleware({
      store,
      chainId: chainId("test-chain"),
      minTurnsBeforeAnalysis: 5,
      minOccurrences: 3,
      onCandidatesDetected: onDetected,
      clock: () => 2000,
    });

    // Turn 5 — at minTurns threshold
    await handle.middleware.onAfterTurn?.(createTurnContext(5));
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(handle.getCandidates().length).toBeGreaterThan(0);
  });

  test("respects cooldown between analyses", async () => {
    const traces = [
      createTrace(0, ["fetch", "parse"]),
      createTrace(1, ["fetch", "parse"]),
      createTrace(2, ["fetch", "parse"]),
      createTrace(3, ["fetch", "parse"]),
      createTrace(4, ["fetch", "parse"]),
    ];
    const store = createMockStore(traces);
    const onDetected = mock((_: readonly CrystallizationCandidate[]) => {});

    const handle = createCrystallizeMiddleware({
      store,
      chainId: chainId("test-chain"),
      minTurnsBeforeAnalysis: 5,
      minOccurrences: 3,
      analysisCooldownTurns: 3,
      onCandidatesDetected: onDetected,
      clock: () => 2000,
    });

    // Turn 5 — first analysis
    await handle.middleware.onAfterTurn?.(createTurnContext(5));
    expect(onDetected).toHaveBeenCalledTimes(1);

    // Turn 6 — within cooldown (5 + 3 = 8)
    await handle.middleware.onAfterTurn?.(createTurnContext(6));
    expect(onDetected).toHaveBeenCalledTimes(1); // No new call
  });

  test("dismiss removes candidate and prevents re-detection", async () => {
    const traces = [
      createTrace(0, ["fetch", "parse"]),
      createTrace(1, ["fetch", "parse"]),
      createTrace(2, ["fetch", "parse"]),
      createTrace(3, ["fetch", "parse"]),
      createTrace(4, ["fetch", "parse"]),
    ];
    const store = createMockStore(traces);
    const onDetected = mock((_: readonly CrystallizationCandidate[]) => {});

    const handle = createCrystallizeMiddleware({
      store,
      chainId: chainId("test-chain"),
      minTurnsBeforeAnalysis: 5,
      minOccurrences: 3,
      onCandidatesDetected: onDetected,
      clock: () => 2000,
    });

    await handle.middleware.onAfterTurn?.(createTurnContext(5));
    const candidatesBefore = handle.getCandidates();
    expect(candidatesBefore.length).toBeGreaterThan(0);

    // Dismiss the first candidate
    const firstKey = candidatesBefore[0]?.ngram.key;
    if (firstKey !== undefined) {
      handle.dismiss(firstKey);
    }
    const candidatesAfter = handle.getCandidates();
    expect(candidatesAfter.find((c) => c.ngram.key === firstKey)).toBeUndefined();
  });

  test("describeCapabilities returns undefined when no candidates", () => {
    const store = createMockStore([]);
    const handle = createCrystallizeMiddleware({
      store,
      chainId: chainId("test-chain"),
      onCandidatesDetected: () => {},
      clock: () => 2000,
    });

    const fragment = handle.middleware.describeCapabilities?.(createTurnContext(0));
    expect(fragment).toBeUndefined();
  });

  test("describeCapabilities returns fragment when candidates exist", async () => {
    const traces = [
      createTrace(0, ["fetch", "parse"]),
      createTrace(1, ["fetch", "parse"]),
      createTrace(2, ["fetch", "parse"]),
      createTrace(3, ["fetch", "parse"]),
      createTrace(4, ["fetch", "parse"]),
    ];
    const store = createMockStore(traces);

    const handle = createCrystallizeMiddleware({
      store,
      chainId: chainId("test-chain"),
      minTurnsBeforeAnalysis: 5,
      minOccurrences: 3,
      onCandidatesDetected: () => {},
      clock: () => 2000,
    });

    await handle.middleware.onAfterTurn?.(createTurnContext(5));
    const fragment = handle.middleware.describeCapabilities?.(createTurnContext(5));
    expect(fragment).toBeDefined();
    expect(fragment?.label).toBe("crystallize");
    expect(fragment?.description).toContain("repeating tool pattern");
  });

  test("does not fire callback for already-known candidates", async () => {
    const traces = [
      createTrace(0, ["fetch", "parse"]),
      createTrace(1, ["fetch", "parse"]),
      createTrace(2, ["fetch", "parse"]),
      createTrace(3, ["fetch", "parse"]),
      createTrace(4, ["fetch", "parse"]),
    ];
    const store = createMockStore(traces);
    const onDetected = mock((_: readonly CrystallizationCandidate[]) => {});

    const handle = createCrystallizeMiddleware({
      store,
      chainId: chainId("test-chain"),
      minTurnsBeforeAnalysis: 5,
      minOccurrences: 3,
      analysisCooldownTurns: 1,
      onCandidatesDetected: onDetected,
      clock: () => 2000,
    });

    // First analysis at turn 5
    await handle.middleware.onAfterTurn?.(createTurnContext(5));
    expect(onDetected).toHaveBeenCalledTimes(1);

    // Second analysis at turn 7 — same patterns, no new callback
    await handle.middleware.onAfterTurn?.(createTurnContext(7));
    expect(onDetected).toHaveBeenCalledTimes(1);
  });
});
