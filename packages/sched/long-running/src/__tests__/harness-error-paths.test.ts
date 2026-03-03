/**
 * Harness error-path tests — behavioral baseline.
 *
 * Tests cover:
 * 1. resume() with engine state recovery (from session record)
 * 2. fail() transitions harness to "failed" phase
 * 3. pause() with engineState persists via saveSession()
 * 4. resume() without engine state falls back to context reconstruction
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type {
  EngineMetrics,
  EngineState,
  HarnessSnapshotStore,
  SessionPersistence,
  SessionRecord,
  TaskBoardSnapshot,
} from "@koi/core";
import { agentId, harnessId, taskItemId } from "@koi/core";
import { createInMemorySnapshotChainStore } from "@koi/snapshot-chain-store";
import { assertErr, assertOk } from "@koi/test-utils";
import { createLongRunningHarness } from "../harness.js";
import type { LongRunningConfig, SessionResult } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_HARNESS_ID = harnessId("error-paths-harness");
const TEST_AGENT_ID = agentId("agent-error-paths");

const METRICS: EngineMetrics = {
  totalTokens: 50,
  inputTokens: 30,
  outputTokens: 20,
  turns: 2,
  durationMs: 1000,
};

function createPlan(count = 2): TaskBoardSnapshot {
  return {
    items: Array.from({ length: count }, (_, i) => ({
      id: taskItemId(`task-${String(i + 1)}`),
      description: `Task ${String(i + 1)}`,
      dependencies: [],
      priority: i,
      maxRetries: 3,
      retries: 0,
      status: "pending" as const,
    })),
    results: [],
  };
}

const MOCK_ENGINE_STATE: EngineState = {
  engineId: "test-engine",
  data: { messages: ["msg-1", "msg-2"], cursor: 42 },
};

function createMockPersistence(overrides?: Partial<SessionPersistence>): SessionPersistence {
  const savedSessions = new Map<string, SessionRecord>();

  return {
    saveSession: (record: SessionRecord) => {
      savedSessions.set(record.sessionId, record);
      return { ok: true as const, value: undefined };
    },
    loadSession: (sid: string) => {
      const record = savedSessions.get(sid);
      if (record !== undefined) {
        return { ok: true as const, value: record };
      }
      return {
        ok: false as const,
        error: { code: "NOT_FOUND" as const, message: "Not found", retryable: false },
      };
    },
    removeSession: () => ({ ok: true as const, value: undefined }),
    listSessions: () => ({ ok: true as const, value: [] }),
    savePendingFrame: () => ({ ok: true as const, value: undefined }),
    loadPendingFrames: () => ({ ok: true as const, value: [] }),
    clearPendingFrames: () => ({ ok: true as const, value: undefined }),
    removePendingFrame: () => ({ ok: true as const, value: undefined }),
    recover: () => ({
      ok: true as const,
      value: { sessions: [], pendingFrames: new Map(), skipped: [] },
    }),
    close: () => undefined,
    ...overrides,
  };
}

function createHarness(
  store: HarnessSnapshotStore,
  overrides?: Partial<LongRunningConfig>,
): ReturnType<typeof createLongRunningHarness> {
  return createLongRunningHarness({
    harnessId: TEST_HARNESS_ID,
    agentId: TEST_AGENT_ID,
    harnessStore: store,
    sessionPersistence: createMockPersistence(overrides?.sessionPersistence as undefined),
    ...overrides,
  });
}

function makeSessionResult(sid: string, engineState?: EngineState): SessionResult {
  return {
    sessionId: sid,
    metrics: METRICS,
    summary: "Session completed some work.",
    engineState,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("harness error paths", () => {
  let store: HarnessSnapshotStore;

  beforeEach(() => {
    store = createInMemorySnapshotChainStore();
  });

  // -----------------------------------------------------------------------
  // 1. resume() with engine state recovery
  // -----------------------------------------------------------------------

  test("resume() restores engine state from session record when available", async () => {
    const persistence = createMockPersistence();

    const harness = createLongRunningHarness({
      harnessId: TEST_HARNESS_ID,
      agentId: TEST_AGENT_ID,
      harnessStore: store,
      sessionPersistence: persistence,
    });

    // Start → pause with engine state → resume
    const startResult = await harness.start(createPlan());
    assertOk(startResult);

    const pauseResult = await harness.pause(makeSessionResult("s-1", MOCK_ENGINE_STATE));
    assertOk(pauseResult);
    expect(harness.status().phase).toBe("suspended");

    const resumeResult = await harness.resume();
    assertOk(resumeResult);

    // Engine state should be recovered from session record
    expect(resumeResult.value.engineStateRecovered).toBe(true);
    expect(resumeResult.value.engineInput.kind).toBe("resume");
    if (resumeResult.value.engineInput.kind === "resume") {
      expect(resumeResult.value.engineInput.state).toEqual(MOCK_ENGINE_STATE);
    }
    expect(harness.status().phase).toBe("active");
  });

  // -----------------------------------------------------------------------
  // 2. fail() transitions to "failed" phase
  // -----------------------------------------------------------------------

  test("fail() transitions harness to failed phase with error reason", async () => {
    const harness = createHarness(store);

    const startResult = await harness.start(createPlan());
    assertOk(startResult);
    expect(harness.status().phase).toBe("active");

    const failResult = await harness.fail({
      code: "INTERNAL",
      message: "Unrecoverable model failure",
      retryable: false,
    });
    assertOk(failResult);

    expect(harness.status().phase).toBe("failed");
    expect(harness.status().failureReason).toBe("Unrecoverable model failure");
  });

  test("fail() from suspended phase transitions to failed", async () => {
    const harness = createHarness(store);

    await harness.start(createPlan());
    await harness.pause(makeSessionResult("s-1"));
    expect(harness.status().phase).toBe("suspended");

    const failResult = await harness.fail({
      code: "TIMEOUT",
      message: "Session timed out during suspension",
      retryable: false,
    });
    assertOk(failResult);

    expect(harness.status().phase).toBe("failed");
    expect(harness.status().failureReason).toBe("Session timed out during suspension");
  });

  test("fail() from idle phase returns validation error", async () => {
    const harness = createHarness(store);

    const failResult = await harness.fail({
      code: "INTERNAL",
      message: "Cannot fail from idle",
      retryable: false,
    });
    assertErr(failResult);
    expect(failResult.error.code).toBe("VALIDATION");
  });

  // -----------------------------------------------------------------------
  // 3. pause() with engineState persists via saveSession()
  // -----------------------------------------------------------------------

  test("pause() with engineState saves session record with lastEngineState", async () => {
    let savedRecord: SessionRecord | undefined;
    const persistence = createMockPersistence({
      saveSession: (record: SessionRecord) => {
        savedRecord = record;
        return { ok: true as const, value: undefined };
      },
    });

    const harness = createLongRunningHarness({
      harnessId: TEST_HARNESS_ID,
      agentId: TEST_AGENT_ID,
      harnessStore: store,
      sessionPersistence: persistence,
    });

    await harness.start(createPlan());

    const pauseResult = await harness.pause(makeSessionResult("s-1", MOCK_ENGINE_STATE));
    assertOk(pauseResult);

    // Verify the session record was saved with engine state
    expect(savedRecord).toBeDefined();
    expect(savedRecord?.lastEngineState).toEqual(MOCK_ENGINE_STATE);
  });

  test("pause() without engineState saves session record without lastEngineState", async () => {
    let savedRecord: SessionRecord | undefined;
    const persistence = createMockPersistence({
      saveSession: (record: SessionRecord) => {
        savedRecord = record;
        return { ok: true as const, value: undefined };
      },
    });

    const harness = createLongRunningHarness({
      harnessId: TEST_HARNESS_ID,
      agentId: TEST_AGENT_ID,
      harnessStore: store,
      sessionPersistence: persistence,
    });

    await harness.start(createPlan());

    // Pause without engineState
    const pauseResult = await harness.pause({
      sessionId: "s-1",
      metrics: METRICS,
    });
    assertOk(pauseResult);

    // Session record should NOT have engine state
    expect(savedRecord).toBeDefined();
    expect(savedRecord?.lastEngineState).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // 4. resume() without engine state falls back to context reconstruction
  // -----------------------------------------------------------------------

  test("resume() without engine state builds context from summaries", async () => {
    // Default mock persistence returns NOT_FOUND for loadSession
    const harness = createHarness(store);

    // Start, produce a summary, then pause
    const startResult = await harness.start(createPlan());
    assertOk(startResult);

    const pauseResult = await harness.pause({
      sessionId: "s-1",
      metrics: METRICS,
      summary: "Completed initial analysis. Found 3 issues to address.",
    });
    assertOk(pauseResult);

    // Resume — no engine state available, should fall back to context reconstruction
    const resumeResult = await harness.resume();
    assertOk(resumeResult);

    expect(resumeResult.value.engineStateRecovered).toBe(false);
    expect(resumeResult.value.engineInput.kind).toBe("messages");

    // The messages should contain the summary text
    if (resumeResult.value.engineInput.kind === "messages") {
      const messages = resumeResult.value.engineInput.messages;
      expect(messages.length).toBeGreaterThan(0);

      // Look for summary text in the reconstructed context
      const firstMessage = messages[0];
      expect(firstMessage).toBeDefined();
      if (firstMessage !== undefined) {
        const textContent = firstMessage.content.find((c) => c.kind === "text");
        expect(textContent).toBeDefined();
        if (textContent !== undefined && textContent.kind === "text") {
          expect(textContent.text).toContain("Task Plan");
          expect(textContent.text).toContain("Completed initial analysis");
        }
      }
    }
  });

  test("resume() with no snapshot returns validation error", async () => {
    // Create a harness but trick it into suspended phase without a snapshot
    // by starting, pausing, and then creating a fresh harness that loads from store
    const harness = createHarness(store);

    // start → pause puts it in suspended state
    await harness.start(createPlan());
    await harness.pause(makeSessionResult("s-1"));

    // Create a new harness pointing to the same store
    // The new harness will be in idle phase, so it can't resume
    const harness2 = createHarness(store);
    const resumeResult = await harness2.resume();
    assertErr(resumeResult);
    expect(resumeResult.error.code).toBe("VALIDATION");
  });
});
