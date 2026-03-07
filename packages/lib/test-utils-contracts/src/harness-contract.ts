/**
 * Contract test suite for LongRunningHarness implementations.
 *
 * Validates the core start → pause → resume lifecycle, status transitions,
 * and dispose idempotency. Designed to be reused by any harness implementation.
 */

import { describe, expect, test } from "bun:test";
import type {
  EngineMetrics,
  HarnessId,
  HarnessStatus,
  KoiError,
  KoiMiddleware,
  Result,
  TaskBoardSnapshot,
  TaskItemId,
  TaskResult,
} from "@koi/core";
import { taskItemId } from "@koi/core";
import { assertErr, assertOk } from "@koi/test-utils-mocks";

// ---------------------------------------------------------------------------
// Session result shape (avoid depending on L2)
// ---------------------------------------------------------------------------

interface ContractSessionResult {
  readonly sessionId: string;
  readonly metrics: EngineMetrics;
  readonly summary?: string | undefined;
}

// ---------------------------------------------------------------------------
// Harness interface for contract testing
// ---------------------------------------------------------------------------

interface ContractHarness {
  readonly harnessId: HarnessId;
  readonly start: (plan: TaskBoardSnapshot) => Promise<Result<unknown, KoiError>>;
  readonly resume: () => Promise<Result<unknown, KoiError>>;
  readonly pause: (result: ContractSessionResult) => Promise<Result<void, KoiError>>;
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
// Default test fixtures
// ---------------------------------------------------------------------------

const DEFAULT_METRICS: EngineMetrics = {
  totalTokens: 100,
  inputTokens: 60,
  outputTokens: 40,
  turns: 3,
  durationMs: 2000,
};

function createContractPlan(): TaskBoardSnapshot {
  return {
    items: [
      {
        id: taskItemId("contract-task-1"),
        description: "Contract task 1",
        dependencies: [],
        priority: 0,
        maxRetries: 3,
        retries: 0,
        status: "pending" as const,
      },
      {
        id: taskItemId("contract-task-2"),
        description: "Contract task 2",
        dependencies: [],
        priority: 1,
        maxRetries: 3,
        retries: 0,
        status: "pending" as const,
      },
    ],
    results: [],
  };
}

// ---------------------------------------------------------------------------
// Contract test suite
// ---------------------------------------------------------------------------

/**
 * Run the harness contract test suite against a factory.
 *
 * The factory is called before each test group to create a fresh harness.
 * Tests validate lifecycle transitions, status reporting, and dispose behavior.
 */
export function runHarnessContractTests(
  factory: () => ContractHarness | Promise<ContractHarness>,
): void {
  describe("harness contract", () => {
    test("starts in idle phase", async () => {
      const harness = await factory();
      expect(harness.status().phase).toBe("idle");
    });

    test("start transitions to active", async () => {
      const harness = await factory();
      const result = await harness.start(createContractPlan());
      assertOk(result);
      expect(harness.status().phase).toBe("active");
    });

    test("start rejects empty plan", async () => {
      const harness = await factory();
      const result = await harness.start({ items: [], results: [] });
      assertErr(result);
    });

    test("pause transitions to suspended", async () => {
      const harness = await factory();
      await harness.start(createContractPlan());
      const result = await harness.pause({
        sessionId: "s-1",
        metrics: DEFAULT_METRICS,
        summary: "Test",
      });
      assertOk(result);
      expect(harness.status().phase).toBe("suspended");
    });

    test("resume transitions back to active", async () => {
      const harness = await factory();
      await harness.start(createContractPlan());
      await harness.pause({ sessionId: "s-1", metrics: DEFAULT_METRICS });
      const result = await harness.resume();
      assertOk(result);
      expect(harness.status().phase).toBe("active");
    });

    test("start → pause → resume → pause cycle", async () => {
      const harness = await factory();
      await harness.start(createContractPlan());
      await harness.pause({ sessionId: "s-1", metrics: DEFAULT_METRICS });
      await harness.resume();
      const result = await harness.pause({ sessionId: "s-2", metrics: DEFAULT_METRICS });
      assertOk(result);
      expect(harness.status().phase).toBe("suspended");
    });

    test("completeTask marks task done", async () => {
      const harness = await factory();
      await harness.start(createContractPlan());
      const result = await harness.completeTask(taskItemId("contract-task-1"), {
        taskId: taskItemId("contract-task-1"),
        output: "Done",
        durationMs: 100,
      });
      assertOk(result);
    });

    test("completing all tasks transitions to completed", async () => {
      const harness = await factory();
      await harness.start(createContractPlan());
      await harness.completeTask(taskItemId("contract-task-1"), {
        taskId: taskItemId("contract-task-1"),
        output: "Done",
        durationMs: 100,
      });
      await harness.completeTask(taskItemId("contract-task-2"), {
        taskId: taskItemId("contract-task-2"),
        output: "Done",
        durationMs: 100,
      });
      expect(harness.status().phase).toBe("completed");
    });

    test("status returns harness ID", async () => {
      const harness = await factory();
      expect(harness.status().harnessId).toBe(harness.harnessId);
    });

    test("status reflects task board", async () => {
      const harness = await factory();
      await harness.start(createContractPlan());
      expect(harness.status().taskBoard.items.length).toBe(2);
    });

    test("status reflects metrics after pause", async () => {
      const harness = await factory();
      await harness.start(createContractPlan());
      await harness.pause({ sessionId: "s-1", metrics: DEFAULT_METRICS });
      expect(harness.status().metrics.totalSessions).toBe(1);
    });

    test("createMiddleware returns valid middleware", async () => {
      const harness = await factory();
      const mw = harness.createMiddleware();
      expect(mw.name).toBeTruthy();
    });

    test("dispose is idempotent", async () => {
      const harness = await factory();
      await harness.dispose();
      await harness.dispose(); // No throw
    });

    test("dispose prevents start", async () => {
      const harness = await factory();
      await harness.dispose();
      const result = await harness.start(createContractPlan());
      assertErr(result);
    });

    test("dispose prevents resume", async () => {
      const harness = await factory();
      await harness.start(createContractPlan());
      await harness.pause({ sessionId: "s-1", metrics: DEFAULT_METRICS });
      await harness.dispose();
      const result = await harness.resume();
      assertErr(result);
    });

    test("dispose prevents completeTask", async () => {
      const harness = await factory();
      await harness.start(createContractPlan());
      await harness.dispose();
      const result = await harness.completeTask(taskItemId("contract-task-1"), {
        taskId: taskItemId("contract-task-1"),
        output: "Done",
        durationMs: 100,
      });
      assertErr(result);
    });

    test("fail transitions to failed phase", async () => {
      const harness = await factory();
      await harness.start(createContractPlan());
      const error: KoiError = { code: "TIMEOUT", message: "Timed out", retryable: false };
      const result = await harness.fail(error);
      assertOk(result);
      expect(harness.status().phase).toBe("failed");
    });

    test("fail rejects from idle phase", async () => {
      const harness = await factory();
      const error: KoiError = { code: "TIMEOUT", message: "Timed out", retryable: false };
      const result = await harness.fail(error);
      assertErr(result);
    });
  });
}
