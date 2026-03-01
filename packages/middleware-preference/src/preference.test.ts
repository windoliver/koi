import { beforeEach, describe, expect, test } from "bun:test";
import type { MemoryComponent, MemoryResult, MemoryStoreOptions } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type { SessionContext, TurnContext } from "@koi/core/middleware";
import { createPreferenceMiddleware } from "./preference.js";
import type { PreferenceDriftDetector, SalienceGate } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMessage(text: string): InboundMessage {
  return {
    senderId: "user:test",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
}

function createSessionCtx(sessionId: string): SessionContext {
  return { sessionId } as SessionContext;
}

function createTurnCtx(
  sessionId: string,
  messages: readonly InboundMessage[],
  turnIndex: number,
): TurnContext {
  return {
    session: { sessionId } as SessionContext,
    messages,
    turnIndex,
    turnId: `turn-${turnIndex}`,
    metadata: {},
  } as unknown as TurnContext;
}

interface StoredEntry {
  readonly content: string;
  readonly category: string;
}

interface MockMemory {
  readonly component: MemoryComponent;
  readonly stored: StoredEntry[];
  readonly facts: Array<{
    readonly id: string;
    readonly content: string;
    readonly category: string;
    readonly status: string;
  }>;
}

function createMockMemory(): MockMemory {
  const stored: StoredEntry[] = [];
  const facts: Array<{
    readonly id: string;
    readonly content: string;
    readonly category: string;
    readonly status: string;
  }> = [];

  // let — needed for incrementing fact counter
  let factCounter = 0;

  const component: MemoryComponent = {
    async recall(_query: string): Promise<readonly MemoryResult[]> {
      return facts
        .filter((f) => f.status === "active")
        .map((f) => ({
          content: f.content,
          score: 0.9,
          metadata: { id: f.id, category: f.category, status: f.status },
        }));
    },
    async store(content: string, options?: MemoryStoreOptions): Promise<void> {
      factCounter += 1;
      const id = `fact-${factCounter}`;
      const category = options?.category ?? "context";
      facts.push({ id, content, category, status: "active" });
      stored.push({ content, category });
    },
  };

  return { component, stored, facts };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPreferenceMiddleware", () => {
  // let — needed for mutable test fixtures per test
  let mockMem: MockMemory;

  beforeEach(() => {
    mockMem = createMockMemory();
  });

  test("stores new preference when drift is detected", async () => {
    const driftDetector: PreferenceDriftDetector = {
      detect: () => ({
        kind: "drift_detected",
        newPreference: "I now prefer light mode",
      }),
    };

    const mw = createPreferenceMiddleware({
      driftDetector,
      memory: mockMem.component,
    });

    const sessionCtx = createSessionCtx("s1");
    await mw.onSessionStart?.(sessionCtx);

    const turnCtx = createTurnCtx("s1", [createMessage("I now prefer light mode")], 1);
    await mw.onBeforeTurn?.(turnCtx);

    expect(mockMem.stored).toHaveLength(1);
    expect(mockMem.stored[0]?.content).toBe("I now prefer light mode");
    expect(mockMem.stored[0]?.category).toBe("preference");
  });

  test("does not store when no drift detected", async () => {
    const driftDetector: PreferenceDriftDetector = {
      detect: () => ({ kind: "no_drift" }),
    };

    const mw = createPreferenceMiddleware({
      driftDetector,
      memory: mockMem.component,
    });

    await mw.onSessionStart?.(createSessionCtx("s1"));
    await mw.onBeforeTurn?.(createTurnCtx("s1", [createMessage("Sounds good!")], 1));

    expect(mockMem.stored).toHaveLength(0);
  });

  test("skips store/recall when memory component is missing", async () => {
    const driftDetector: PreferenceDriftDetector = {
      detect: () => ({
        kind: "drift_detected",
        newPreference: "prefer dark mode",
      }),
    };

    const mw = createPreferenceMiddleware({ driftDetector });

    await mw.onSessionStart?.(createSessionCtx("s1"));
    await mw.onBeforeTurn?.(createTurnCtx("s1", [createMessage("I prefer dark mode")], 1));

    // No error thrown, just skipped
    expect(mockMem.stored).toHaveLength(0);
  });

  test("does not store when salience gate rejects", async () => {
    const driftDetector: PreferenceDriftDetector = {
      detect: () => ({
        kind: "drift_detected",
        newPreference: "ok thanks",
      }),
    };

    const salienceGate: SalienceGate = {
      isSalient: () => false,
    };

    const mw = createPreferenceMiddleware({
      driftDetector,
      salienceGate,
      memory: mockMem.component,
    });

    await mw.onSessionStart?.(createSessionCtx("s1"));
    await mw.onBeforeTurn?.(createTurnCtx("s1", [createMessage("ok thanks")], 1));

    expect(mockMem.stored).toHaveLength(0);
  });

  test("fail-closed: assumes drift when detector throws", async () => {
    const driftDetector: PreferenceDriftDetector = {
      detect: () => {
        throw new Error("detector crash");
      },
    };

    const mw = createPreferenceMiddleware({
      driftDetector,
      memory: mockMem.component,
    });

    await mw.onSessionStart?.(createSessionCtx("s1"));
    await mw.onBeforeTurn?.(createTurnCtx("s1", [createMessage("switch to vim")], 1));

    // Should have stored because fail-closed assumes drift
    expect(mockMem.stored).toHaveLength(1);
    expect(mockMem.stored[0]?.content).toBe("switch to vim");
    expect(mockMem.stored[0]?.category).toBe("preference");
  });

  test("cleans up session state on session end", async () => {
    const driftDetector: PreferenceDriftDetector = {
      detect: () => ({ kind: "no_drift" }),
    };

    const mw = createPreferenceMiddleware({
      driftDetector,
      memory: mockMem.component,
    });

    const sessionCtx = createSessionCtx("s1");
    await mw.onSessionStart?.(sessionCtx);
    await mw.onSessionEnd?.(sessionCtx);

    // After session end, onBeforeTurn should be a no-op (no session state)
    await mw.onBeforeTurn?.(createTurnCtx("s1", [createMessage("anything")], 1));

    expect(mockMem.stored).toHaveLength(0);
  });
});
