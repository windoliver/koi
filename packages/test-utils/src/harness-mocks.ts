/**
 * Mock factories for @koi/long-running harness testing.
 *
 * Provides pre-built mocks for LongRunningHarness, TaskBoardSnapshot,
 * and ContextSummary — usable across all packages that test harness integration.
 */

import type {
  ContextSummary,
  HarnessId,
  HarnessMetrics,
  HarnessPhase,
  HarnessStatus,
  KoiError,
  KoiMiddleware,
  Result,
  TaskBoardSnapshot,
  TaskItemId,
  TaskResult,
} from "@koi/core";
import { harnessId, taskItemId } from "@koi/core";

// ---------------------------------------------------------------------------
// Harness interface (local copy to avoid L2 dep)
// ---------------------------------------------------------------------------

/**
 * Minimal harness interface matching @koi/long-running's LongRunningHarness.
 * Defined locally to avoid L2→L2 dependency from test-utils to long-running.
 */
interface MockLongRunningHarness {
  readonly harnessId: HarnessId;
  readonly start: (taskPlan: TaskBoardSnapshot) => Promise<Result<unknown, KoiError>>;
  readonly resume: () => Promise<Result<unknown, KoiError>>;
  readonly pause: (sessionResult: unknown) => Promise<Result<void, KoiError>>;
  readonly fail: (error: KoiError) => Promise<Result<void, KoiError>>;
  readonly completeTask: (
    taskId: TaskItemId,
    result: TaskResult,
  ) => Promise<Result<void, KoiError>>;
  readonly status: () => HarnessStatus;
  readonly createMiddleware: () => KoiMiddleware;
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

const DEFAULT_HARNESS_METRICS: HarnessMetrics = {
  totalSessions: 0,
  totalTurns: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  completedTaskCount: 0,
  pendingTaskCount: 0,
  elapsedMs: 0,
};

// ---------------------------------------------------------------------------
// createMockHarness
// ---------------------------------------------------------------------------

/**
 * Create a mock harness with sensible defaults. Override individual methods
 * for test-specific behavior.
 */
export function createMockHarness(
  overrides?: Partial<MockLongRunningHarness>,
): MockLongRunningHarness {
  const hid = overrides?.harnessId ?? harnessId("mock-harness");
  let currentPhase: HarnessPhase = "idle";

  const defaultStatus: HarnessStatus = {
    harnessId: hid,
    phase: currentPhase,
    currentSessionSeq: 0,
    taskBoard: { items: [], results: [] },
    metrics: DEFAULT_HARNESS_METRICS,
  };

  return {
    harnessId: hid,
    async start(_plan: TaskBoardSnapshot) {
      currentPhase = "active";
      return {
        ok: true,
        value: { engineInput: { kind: "text", text: "mock" }, sessionId: "mock-session" },
      };
    },
    async resume() {
      currentPhase = "active";
      return {
        ok: true,
        value: {
          engineInput: { kind: "text", text: "mock-resume" },
          sessionId: "mock-session",
          engineStateRecovered: false,
        },
      };
    },
    async pause(_result: unknown) {
      currentPhase = "suspended";
      return { ok: true, value: undefined };
    },
    async fail(_error: KoiError) {
      currentPhase = "failed";
      return { ok: true, value: undefined };
    },
    async completeTask(_taskId: TaskItemId, _result: TaskResult) {
      return { ok: true, value: undefined };
    },
    status() {
      return { ...defaultStatus, phase: currentPhase };
    },
    createMiddleware() {
      return { name: "mock-harness-middleware" };
    },
    async dispose() {
      // no-op
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createMockTaskPlan
// ---------------------------------------------------------------------------

/**
 * Create a mock TaskBoardSnapshot with the given number of pending tasks.
 */
export function createMockTaskPlan(taskCount = 3): TaskBoardSnapshot {
  return {
    items: Array.from({ length: taskCount }, (_, i) => ({
      id: taskItemId(`mock-task-${String(i + 1)}`),
      description: `Mock task ${String(i + 1)}`,
      dependencies: [],
      priority: i,
      maxRetries: 3,
      retries: 0,
      status: "pending" as const,
    })),
    results: [],
  };
}

// ---------------------------------------------------------------------------
// createMockContextSummary
// ---------------------------------------------------------------------------

/**
 * Create a mock ContextSummary for the given session sequence.
 */
export function createMockContextSummary(sessionSeq = 1): ContextSummary {
  return {
    narrative: `Mock session ${String(sessionSeq)} summary`,
    sessionSeq,
    completedTaskIds: [],
    estimatedTokens: 20,
    generatedAt: Date.now(),
  };
}
