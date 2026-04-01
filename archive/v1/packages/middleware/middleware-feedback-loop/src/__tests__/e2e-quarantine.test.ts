/**
 * E2E: Quarantine flow — when error rate exceeds threshold, the brick gets quarantined.
 *
 * Validates:
 *   1. Error rate exceeds quarantine threshold → brick is quarantined in store
 *   2. Quarantined tool is blocked by feedback loop middleware (returns error feedback)
 *   3. Quarantine fires onQuarantine callback with correct brickId
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  BrickArtifact,
  SnapshotStore,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { brickId, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createInMemoryForgeStore } from "@koi/forge-tools";
import type { ForgeHealthConfig } from "../config.js";
import { createFeedbackLoopMiddleware } from "../feedback-loop.js";
import { createToolHealthTracker } from "../tool-health.js";
import type { ForgeToolErrorFeedback } from "../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FORGED_TOOL_BRICK_ID = brickId("sha256:quarantine-test-tool-001");
const FORGED_TOOL_ID = "forged_quarantine_calc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createForgedBrick(overrides?: Partial<BrickArtifact>): BrickArtifact {
  return {
    id: FORGED_TOOL_BRICK_ID,
    kind: "tool",
    name: FORGED_TOOL_ID,
    description: "A tool for quarantine flow testing",
    scope: "agent",
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    lifecycle: "active",
    provenance: { kind: "system", metadata: {} },
    version: "0.1.0",
    tags: ["quarantine-test"],
    usageCount: 20,
    implementation: "function calc(a, b) { return a + b; }",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
    ...overrides,
  } as BrickArtifact;
}

function createMockSnapshotStore(): SnapshotStore {
  return {
    record: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    get: mock(() => Promise.resolve({ ok: true as const, value: {} as never })),
    list: mock(() => Promise.resolve({ ok: true as const, value: [] as never })),
    history: mock(() => Promise.resolve({ ok: true as const, value: [] as never })),
    latest: mock(() => Promise.resolve({ ok: true as const, value: {} as never })),
  };
}

function resolveBrickId(toolId: string): string | undefined {
  if (toolId === FORGED_TOOL_ID) return FORGED_TOOL_BRICK_ID;
  return undefined;
}

/** Minimal TurnContext stub for middleware wrapToolCall. */
function createMockTurnContext(): TurnContext {
  return {
    agentId: "test-agent",
    turnNumber: 1,
    sessionId: "test-session",
    get: () => undefined,
  } as unknown as TurnContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("e2e: quarantine flow", () => {
  // let: shared per-test mutable state, reset in beforeEach
  let forgeStore: ReturnType<typeof createInMemoryForgeStore>;
  let snapshotStore: SnapshotStore;

  beforeEach(async () => {
    forgeStore = createInMemoryForgeStore();
    snapshotStore = createMockSnapshotStore();
    await forgeStore.save(createForgedBrick());
  });

  // -- Test 1: Error rate exceeds quarantine threshold → brick is quarantined --

  test("quarantines brick when error rate exceeds threshold", async () => {
    const tracker = createToolHealthTracker({
      resolveBrickId,
      forgeStore,
      snapshotStore,
      windowSize: 4,
      quarantineThreshold: 0.5,
      clock: () => Date.now(),
    });

    // Record 4 failures → 100% error rate > 50% threshold
    tracker.recordFailure(FORGED_TOOL_ID, 10, "timeout-1");
    tracker.recordFailure(FORGED_TOOL_ID, 10, "timeout-2");
    tracker.recordFailure(FORGED_TOOL_ID, 10, "timeout-3");
    tracker.recordFailure(FORGED_TOOL_ID, 10, "timeout-4");

    // checkAndQuarantine persists the quarantine state to the store
    const quarantined = await tracker.checkAndQuarantine(FORGED_TOOL_ID);
    expect(quarantined).toBe(true);
    expect(tracker.isQuarantined(FORGED_TOOL_ID)).toBe(true);

    // Verify the store was updated with lifecycle: "failed" (quarantine terminal state)
    const loadResult = await forgeStore.load(FORGED_TOOL_BRICK_ID);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.lifecycle).toBe("failed");
    }

    // Verify snapshot was recorded
    expect(snapshotStore.record).toHaveBeenCalledTimes(1);
  });

  // -- Test 2: Quarantined tool is blocked by feedback loop middleware --

  test("quarantined tool returns error feedback and does not call next", async () => {
    const forgeHealth: ForgeHealthConfig = {
      resolveBrickId,
      forgeStore,
      snapshotStore,
      windowSize: 2,
      quarantineThreshold: 0.5,
    };

    // Pre-quarantine: record failures and persist quarantine
    const tracker = createToolHealthTracker(forgeHealth);
    tracker.recordFailure(FORGED_TOOL_ID, 10, "err-a");
    tracker.recordFailure(FORGED_TOOL_ID, 10, "err-b");
    await tracker.checkAndQuarantine(FORGED_TOOL_ID);
    expect(tracker.isQuarantined(FORGED_TOOL_ID)).toBe(true);

    // Create middleware — it will create its own tracker but should detect
    // quarantine via isQuarantinedAsync (falls back to ForgeStore lifecycle)
    const { middleware } = createFeedbackLoopMiddleware({ forgeHealth });

    const nextFn = mock(
      (_req: ToolRequest): Promise<ToolResponse> =>
        Promise.resolve({ output: "should not be called" }),
    );

    const request: ToolRequest = {
      toolId: FORGED_TOOL_ID,
      input: { a: 1, b: 2 },
    };

    const ctx = createMockTurnContext();

    // wrapToolCall should return error feedback without calling next
    const response = await middleware.wrapToolCall?.(ctx, request, nextFn);

    expect(nextFn).not.toHaveBeenCalled();

    expect(response).toBeDefined();
    const feedback = response?.output as ForgeToolErrorFeedback;
    expect(feedback.error).toContain("quarantined");
    expect(feedback.suggestion).toContain("re-forge");
  });

  // -- Test 3: Quarantine fires onQuarantine callback --

  test("onQuarantine callback fires with correct brickId", async () => {
    const onQuarantine = mock((_brickId: string) => {});

    const tracker = createToolHealthTracker({
      resolveBrickId,
      forgeStore,
      snapshotStore,
      onQuarantine,
      windowSize: 3,
      quarantineThreshold: 0.5,
      clock: () => Date.now(),
    });

    // Record 3 failures → 100% error rate > 50% threshold
    tracker.recordFailure(FORGED_TOOL_ID, 10, "fail-1");
    tracker.recordFailure(FORGED_TOOL_ID, 10, "fail-2");
    tracker.recordFailure(FORGED_TOOL_ID, 10, "fail-3");

    await tracker.checkAndQuarantine(FORGED_TOOL_ID);

    expect(onQuarantine).toHaveBeenCalledTimes(1);
    expect(onQuarantine).toHaveBeenCalledWith(FORGED_TOOL_BRICK_ID);
  });

  // -- Test 4: Below threshold does not quarantine --

  test("does not quarantine when error rate is below threshold", async () => {
    const onQuarantine = mock((_brickId: string) => {});

    const tracker = createToolHealthTracker({
      resolveBrickId,
      forgeStore,
      snapshotStore,
      onQuarantine,
      windowSize: 4,
      quarantineThreshold: 0.5,
      clock: () => Date.now(),
    });

    // Record 1 failure + 3 successes → 25% error rate < 50% threshold
    tracker.recordFailure(FORGED_TOOL_ID, 10, "one-off-error");
    tracker.recordSuccess(FORGED_TOOL_ID, 10);
    tracker.recordSuccess(FORGED_TOOL_ID, 10);
    tracker.recordSuccess(FORGED_TOOL_ID, 10);

    const quarantined = await tracker.checkAndQuarantine(FORGED_TOOL_ID);
    expect(quarantined).toBe(false);
    expect(tracker.isQuarantined(FORGED_TOOL_ID)).toBe(false);

    // Store lifecycle unchanged
    const loadResult = await forgeStore.load(FORGED_TOOL_BRICK_ID);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.lifecycle).toBe("active");
    }

    expect(onQuarantine).not.toHaveBeenCalled();
  });

  // -- Test 5: Quarantine is terminal — further records are ignored --

  test("quarantine is terminal — further records do not change state", async () => {
    const tracker = createToolHealthTracker({
      resolveBrickId,
      forgeStore,
      snapshotStore,
      windowSize: 2,
      quarantineThreshold: 0.5,
      clock: () => Date.now(),
    });

    // Trigger quarantine
    tracker.recordFailure(FORGED_TOOL_ID, 10, "err-1");
    tracker.recordFailure(FORGED_TOOL_ID, 10, "err-2");
    await tracker.checkAndQuarantine(FORGED_TOOL_ID);
    expect(tracker.isQuarantined(FORGED_TOOL_ID)).toBe(true);

    // Record successes after quarantine — state should remain quarantined
    tracker.recordSuccess(FORGED_TOOL_ID, 5);
    tracker.recordSuccess(FORGED_TOOL_ID, 5);
    tracker.recordSuccess(FORGED_TOOL_ID, 5);

    expect(tracker.isQuarantined(FORGED_TOOL_ID)).toBe(true);
  });
});
