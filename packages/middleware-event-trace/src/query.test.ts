import { beforeEach, describe, expect, test } from "bun:test";
import type { ChainId, SnapshotChainStore, TurnTrace } from "@koi/core";
import { chainId, sessionId, toolCallId } from "@koi/core";
import { createInMemorySnapshotChainStore } from "@koi/snapshot-chain-store";
import { getEventsBetween } from "./query.js";

describe("getEventsBetween", () => {
  let store: SnapshotChainStore<TurnTrace>;
  const cid: ChainId = chainId("test-chain");

  beforeEach(() => {
    store = createInMemorySnapshotChainStore<TurnTrace>();
  });

  test("returns empty array for empty store", async () => {
    const result = await getEventsBetween(
      store,
      cid,
      { turnIndex: 0, eventIndex: 0 },
      { turnIndex: 0, eventIndex: 10 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }
  });

  test("returns events within a single turn", async () => {
    const trace: TurnTrace = {
      turnIndex: 0,
      sessionId: sessionId("s1"),
      agentId: "a1",
      events: [
        {
          eventIndex: 0,
          turnIndex: 0,
          event: { kind: "model_call", request: {}, response: {}, durationMs: 10 },
          timestamp: 1000,
        },
        {
          eventIndex: 1,
          turnIndex: 0,
          event: {
            kind: "tool_call",
            toolId: "t1",
            callId: toolCallId("c1"),
            input: {},
            output: {},
            durationMs: 5,
          },
          timestamp: 1010,
        },
        {
          eventIndex: 2,
          turnIndex: 0,
          event: { kind: "model_call", request: {}, response: {}, durationMs: 8 },
          timestamp: 1020,
        },
      ],
      durationMs: 30,
    };
    await store.put(cid, trace, []);

    const result = await getEventsBetween(
      store,
      cid,
      { turnIndex: 0, eventIndex: 0 },
      { turnIndex: 0, eventIndex: 1 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.eventIndex).toBe(0);
      expect(result.value[1]?.eventIndex).toBe(1);
    }
  });

  test("returns events spanning multiple turns", async () => {
    const trace0: TurnTrace = {
      turnIndex: 0,
      sessionId: sessionId("s1"),
      agentId: "a1",
      events: [
        {
          eventIndex: 0,
          turnIndex: 0,
          event: { kind: "model_call", request: {}, response: {}, durationMs: 10 },
          timestamp: 1000,
        },
        {
          eventIndex: 1,
          turnIndex: 0,
          event: {
            kind: "tool_call",
            toolId: "t1",
            callId: toolCallId("c1"),
            input: {},
            output: {},
            durationMs: 5,
          },
          timestamp: 1010,
        },
      ],
      durationMs: 15,
    };
    const putResult0 = await store.put(cid, trace0, []);

    const parentIds =
      putResult0.ok && putResult0.value !== undefined ? [putResult0.value.nodeId] : [];

    const trace1: TurnTrace = {
      turnIndex: 1,
      sessionId: sessionId("s1"),
      agentId: "a1",
      events: [
        {
          eventIndex: 2,
          turnIndex: 1,
          event: { kind: "model_call", request: {}, response: {}, durationMs: 12 },
          timestamp: 2000,
        },
        {
          eventIndex: 3,
          turnIndex: 1,
          event: {
            kind: "tool_call",
            toolId: "t2",
            callId: toolCallId("c2"),
            input: {},
            output: {},
            durationMs: 7,
          },
          timestamp: 2010,
        },
      ],
      durationMs: 20,
    };
    await store.put(cid, trace1, parentIds);

    const result = await getEventsBetween(
      store,
      cid,
      { turnIndex: 0, eventIndex: 1 },
      { turnIndex: 1, eventIndex: 3 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Turn 0: eventIndex 1 only; Turn 1: all events (2, 3)
      expect(result.value).toHaveLength(3);
      expect(result.value[0]?.eventIndex).toBe(1);
      expect(result.value[1]?.eventIndex).toBe(2);
      expect(result.value[2]?.eventIndex).toBe(3);
    }
  });

  test("filters by from.eventIndex correctly", async () => {
    const trace: TurnTrace = {
      turnIndex: 0,
      sessionId: sessionId("s1"),
      agentId: "a1",
      events: [
        {
          eventIndex: 0,
          turnIndex: 0,
          event: { kind: "model_call", request: {}, response: {}, durationMs: 10 },
          timestamp: 1000,
        },
        {
          eventIndex: 1,
          turnIndex: 0,
          event: { kind: "model_call", request: {}, response: {}, durationMs: 10 },
          timestamp: 1010,
        },
        {
          eventIndex: 2,
          turnIndex: 0,
          event: { kind: "model_call", request: {}, response: {}, durationMs: 10 },
          timestamp: 1020,
        },
      ],
      durationMs: 30,
    };
    await store.put(cid, trace, []);

    const result = await getEventsBetween(
      store,
      cid,
      { turnIndex: 0, eventIndex: 2 },
      { turnIndex: 0, eventIndex: 2 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.eventIndex).toBe(2);
    }
  });
});
