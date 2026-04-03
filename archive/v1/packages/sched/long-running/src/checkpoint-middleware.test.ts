import { beforeEach, describe, expect, test } from "bun:test";
import type { SessionContext, TurnContext } from "@koi/core";
import { agentId, runId, sessionId, turnId } from "@koi/core";
import { createCheckpointMiddleware } from "./checkpoint-middleware.js";

function createTurnCtx(turnIndex: number): TurnContext {
  const sid = sessionId("test-session");
  const rid = runId("test-run");
  return {
    session: {
      agentId: agentId("test-agent"),
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

function createSessionCtx(): SessionContext {
  return {
    agentId: agentId("test-agent"),
    sessionId: sessionId("test-session"),
    runId: runId("test-run"),
    metadata: {},
  };
}

describe("createCheckpointMiddleware", () => {
  let checkpoints: Array<{ turnIndex: number; trigger: string }>;

  beforeEach(() => {
    checkpoints = [];
  });

  test("fires checkpoint at default interval (5 turns)", async () => {
    const mw = createCheckpointMiddleware({
      onCheckpoint: (ctx) => {
        checkpoints.push(ctx);
      },
    });

    for (let i = 0; i < 10; i++) {
      await mw.onAfterTurn?.(createTurnCtx(i));
    }

    // Should fire at turn count 5 and 10
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]?.turnIndex).toBe(4); // turnIndex is 0-based, 5th turn has index 4
    expect(checkpoints[1]?.turnIndex).toBe(9);
    expect(checkpoints[0]?.trigger).toBe("interval");
  });

  test("fires checkpoint on session end", async () => {
    const mw = createCheckpointMiddleware({
      onCheckpoint: (ctx) => {
        checkpoints.push(ctx);
      },
    });

    await mw.onAfterTurn?.(createTurnCtx(0));
    await mw.onAfterTurn?.(createTurnCtx(1));
    await mw.onSessionEnd?.(createSessionCtx());

    // Only the session end checkpoint (turns < interval)
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.trigger).toBe("session_end");
  });

  test("respects custom interval", async () => {
    const mw = createCheckpointMiddleware({
      policy: { intervalTurns: 3, onSessionEnd: true, onSuspend: true },
      onCheckpoint: (ctx) => {
        checkpoints.push(ctx);
      },
    });

    for (let i = 0; i < 6; i++) {
      await mw.onAfterTurn?.(createTurnCtx(i));
    }

    // Fires at turn count 3 and 6
    expect(checkpoints).toHaveLength(2);
  });

  test("does not fire session end checkpoint when disabled", async () => {
    const mw = createCheckpointMiddleware({
      policy: { intervalTurns: 100, onSessionEnd: false, onSuspend: true },
      onCheckpoint: (ctx) => {
        checkpoints.push(ctx);
      },
    });

    await mw.onAfterTurn?.(createTurnCtx(0));
    await mw.onSessionEnd?.(createSessionCtx());

    expect(checkpoints).toHaveLength(0);
  });

  test("resets turn counter on session end", async () => {
    const mw = createCheckpointMiddleware({
      policy: { intervalTurns: 3, onSessionEnd: false, onSuspend: true },
      onCheckpoint: (ctx) => {
        checkpoints.push(ctx);
      },
    });

    // First session: 2 turns (no interval checkpoint)
    await mw.onAfterTurn?.(createTurnCtx(0));
    await mw.onAfterTurn?.(createTurnCtx(1));
    await mw.onSessionEnd?.(createSessionCtx());

    // Second session: 3 turns (should fire at turn 3 from start of new session)
    await mw.onAfterTurn?.(createTurnCtx(0));
    await mw.onAfterTurn?.(createTurnCtx(1));
    await mw.onAfterTurn?.(createTurnCtx(2));

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.trigger).toBe("interval");
  });

  test("has correct priority", () => {
    const mw = createCheckpointMiddleware({
      onCheckpoint: () => {},
    });
    expect(mw.priority).toBe(55);
  });
});
