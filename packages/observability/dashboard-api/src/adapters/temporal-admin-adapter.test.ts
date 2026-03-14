/**
 * Tests for createTemporalAdminAdapter.
 *
 * Uses mock objects satisfying TemporalAdminClientLike structural type
 * to verify mapping from Temporal SDK shapes to dashboard view/command types.
 */

import { describe, expect, test } from "bun:test";
import type { TemporalAdminClientLike } from "./temporal-admin-adapter.js";
import { createTemporalAdminAdapter } from "./temporal-admin-adapter.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockWorkflowExecution {
  readonly workflowId: string;
  readonly type: { readonly name: string };
  readonly status: { readonly name: string };
  readonly startTime: Date;
  readonly closeTime: Date | null;
  readonly taskQueue: string;
  readonly runId: string;
  readonly searchAttributes: Record<string, unknown>;
  readonly memo: Record<string, unknown>;
}

function createMockExecution(overrides?: Partial<MockWorkflowExecution>): MockWorkflowExecution {
  return {
    workflowId: "wf-test-1",
    type: { name: "agentWorkflow" },
    status: { name: "RUNNING" },
    startTime: new Date("2026-01-15T10:00:00Z"),
    closeTime: null,
    taskQueue: "koi-default",
    runId: "run-abc-123",
    searchAttributes: {},
    memo: {},
    ...overrides,
  };
}

interface MockHistoryEvent {
  readonly eventType: string;
  readonly eventTime: Date;
  readonly [key: string]: unknown;
}

interface MockWorkflowHandle {
  describe: () => Promise<{
    readonly workflowId: string;
    readonly type: { readonly name: string };
    readonly status: { readonly name: string };
    readonly startTime: Date;
    readonly closeTime: Date | null;
    readonly taskQueue: string;
    readonly runId: string;
    readonly searchAttributes: Record<string, unknown>;
    readonly memo: Record<string, unknown>;
    readonly pendingActivities: readonly unknown[];
    readonly pendingNexusOperations?: readonly unknown[];
  }>;
  signal: (signalName: string, ...args: readonly unknown[]) => Promise<void>;
  terminate: (reason?: string) => Promise<void>;
  query: (queryType: string) => Promise<unknown>;
  fetchHistory: () => Promise<{ readonly events: readonly MockHistoryEvent[] }>;
}

function createMockClient(options?: {
  readonly executions?: readonly MockWorkflowExecution[];
  readonly handleDescribe?: MockWorkflowHandle["describe"];
  readonly handleSignal?: MockWorkflowHandle["signal"];
  readonly handleTerminate?: MockWorkflowHandle["terminate"];
  readonly handleQuery?: MockWorkflowHandle["query"];
  readonly handleFetchHistory?: MockWorkflowHandle["fetchHistory"];
  readonly healthCheckFn?: () => Promise<void>;
}): TemporalAdminClientLike {
  const executions = options?.executions ?? [createMockExecution()];

  const mockHandle: MockWorkflowHandle = {
    describe:
      options?.handleDescribe ??
      (async () => ({
        workflowId: "wf-test-1",
        type: { name: "agentWorkflow" },
        status: { name: "RUNNING" },
        startTime: new Date("2026-01-15T10:00:00Z"),
        closeTime: null,
        taskQueue: "koi-default",
        runId: "run-abc-123",
        searchAttributes: {},
        memo: {},
        pendingActivities: [],
      })),
    signal: options?.handleSignal ?? (async () => {}),
    terminate: options?.handleTerminate ?? (async () => {}),
    query:
      options?.handleQuery ??
      (async () => {
        throw new Error("Query not supported");
      }),
    fetchHistory:
      options?.handleFetchHistory ??
      (async () => {
        throw new Error("History not available");
      }),
  };

  return {
    workflow: {
      list: () => ({
        async *[Symbol.asyncIterator]() {
          for (const exec of executions) {
            yield exec;
          }
        },
      }),
      getHandle: (_workflowId: string) => mockHandle,
    },
    connection: {
      healthCheck: options?.healthCheckFn ?? (async () => {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: listWorkflows
// ---------------------------------------------------------------------------

describe("createTemporalAdminAdapter", () => {
  describe("views.listWorkflows", () => {
    test("maps SDK workflow executions to WorkflowSummary array", async () => {
      const executions: readonly MockWorkflowExecution[] = [
        createMockExecution({
          workflowId: "wf-1",
          type: { name: "agentWorkflow" },
          status: { name: "RUNNING" },
          startTime: new Date("2026-01-15T10:00:00Z"),
          closeTime: null,
          taskQueue: "koi-default",
        }),
        createMockExecution({
          workflowId: "wf-2",
          type: { name: "cronWorkflow" },
          status: { name: "COMPLETED" },
          startTime: new Date("2026-01-14T08:00:00Z"),
          closeTime: new Date("2026-01-14T09:00:00Z"),
          taskQueue: "koi-cron",
        }),
      ];

      const client = createMockClient({ executions });
      const adapter = createTemporalAdminAdapter(client);
      const results = await adapter.views.listWorkflows();

      expect(results).toHaveLength(2);

      expect(results[0]).toEqual({
        workflowId: "wf-1",
        workflowType: "agentWorkflow",
        status: "running",
        startTime: new Date("2026-01-15T10:00:00Z").getTime(),
        taskQueue: "koi-default",
      });

      expect(results[1]).toEqual({
        workflowId: "wf-2",
        workflowType: "cronWorkflow",
        status: "completed",
        startTime: new Date("2026-01-14T08:00:00Z").getTime(),
        closeTime: new Date("2026-01-14T09:00:00Z").getTime(),
        taskQueue: "koi-cron",
      });
    });

    test("returns empty array when no workflows exist", async () => {
      const client = createMockClient({ executions: [] });
      const adapter = createTemporalAdminAdapter(client);
      const results = await adapter.views.listWorkflows();

      expect(results).toEqual([]);
    });

    test("maps all known Temporal status names to dashboard status", async () => {
      const statuses = [
        { sdk: "RUNNING", expected: "running" },
        { sdk: "COMPLETED", expected: "completed" },
        { sdk: "FAILED", expected: "failed" },
        { sdk: "CANCELLED", expected: "cancelled" },
        { sdk: "TERMINATED", expected: "terminated" },
        { sdk: "TIMED_OUT", expected: "timed_out" },
      ] as const;

      for (const { sdk, expected } of statuses) {
        const client = createMockClient({
          executions: [createMockExecution({ status: { name: sdk } })],
        });
        const adapter = createTemporalAdminAdapter(client);
        const results = await adapter.views.listWorkflows();
        expect(results[0]?.status).toBe(expected);
      }
    });

    test("maps unknown status to failed as fallback", async () => {
      const client = createMockClient({
        executions: [createMockExecution({ status: { name: "UNKNOWN_STATUS" } })],
      });
      const adapter = createTemporalAdminAdapter(client);
      const results = await adapter.views.listWorkflows();
      expect(results[0]?.status).toBe("failed");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: getWorkflow
  // ---------------------------------------------------------------------------

  describe("views.getWorkflow", () => {
    test("maps SDK workflow description to WorkflowDetail", async () => {
      const describeResult = {
        workflowId: "wf-detail-1",
        type: { name: "agentWorkflow" },
        status: { name: "RUNNING" },
        startTime: new Date("2026-01-15T10:00:00Z"),
        closeTime: null,
        taskQueue: "koi-default",
        runId: "run-xyz",
        searchAttributes: { customField: "value" },
        memo: { note: "test memo" },
        pendingActivities: [{}, {}],
      };

      const client = createMockClient({
        handleDescribe: async () => describeResult,
      });

      const adapter = createTemporalAdminAdapter(client);
      const result = await adapter.views.getWorkflow("wf-detail-1");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
        expect(result.value?.workflowId).toBe("wf-detail-1");
        expect(result.value?.workflowType).toBe("agentWorkflow");
        expect(result.value?.status).toBe("running");
        expect(result.value?.runId).toBe("run-xyz");
        expect(result.value?.pendingActivities).toBe(2);
        expect(result.value?.pendingSignals).toBe(0);
        expect(result.value?.canCount).toBe(0);
        expect(result.value?.searchAttributes).toEqual({ customField: "value" });
        expect(result.value?.memo).toEqual({ note: "test memo" });
      }
    });

    test("returns ok with undefined for not-found error", async () => {
      const client = createMockClient({
        handleDescribe: async () => {
          throw new Error("Workflow not found");
        },
      });

      const adapter = createTemporalAdminAdapter(client);
      const result = await adapter.views.getWorkflow("nonexistent");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
    });

    test("returns error result for operational failures", async () => {
      const client = createMockClient({
        handleDescribe: async () => {
          throw new Error("Connection refused: Temporal server unavailable");
        },
      });

      const adapter = createTemporalAdminAdapter(client);
      const result = await adapter.views.getWorkflow("wf-1");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("EXTERNAL");
        expect(result.error.message).toContain("Connection refused");
        expect(result.error.retryable).toBe(true);
        expect(result.error.context).toEqual({ workflowId: "wf-1" });
      }
    });

    test("includes timeline from workflow history when available", async () => {
      const client = createMockClient({
        handleFetchHistory: async () => ({
          events: [
            {
              eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED",
              eventTime: new Date("2026-01-15T10:00:00Z"),
            },
            {
              eventType: "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED",
              eventTime: new Date("2026-01-15T10:00:01Z"),
              activityTaskScheduledEventAttributes: {
                activityType: { name: "runTool" },
              },
            },
            {
              eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED",
              eventTime: new Date("2026-01-15T10:00:05Z"),
              workflowExecutionSignaledEventAttributes: {
                signalName: "refresh",
              },
            },
            {
              eventType: "EVENT_TYPE_ACTIVITY_TASK_COMPLETED",
              eventTime: new Date("2026-01-15T10:00:10Z"),
            },
          ],
        }),
      });

      const adapter = createTemporalAdminAdapter(client);
      const result = await adapter.views.getWorkflow("wf-test-1");

      expect(result.ok).toBe(true);
      if (result.ok && result.value !== undefined) {
        expect(result.value.timeline).toBeDefined();
        const timeline = result.value.timeline;
        if (timeline === undefined) return;
        expect(timeline).toHaveLength(4);

        expect(timeline[0]).toEqual({
          time: new Date("2026-01-15T10:00:00Z").getTime(),
          label: "Workflow started",
          category: "lifecycle",
        });
        expect(timeline[1]).toEqual({
          time: new Date("2026-01-15T10:00:01Z").getTime(),
          label: "Activity: runTool",
          category: "activity",
        });
        expect(timeline[2]).toEqual({
          time: new Date("2026-01-15T10:00:05Z").getTime(),
          label: "Signal: refresh",
          category: "signal",
        });
        expect(timeline[3]).toEqual({
          time: new Date("2026-01-15T10:00:10Z").getTime(),
          label: "Activity completed",
          category: "activity",
        });
      }
    });

    test("omits timeline when fetchHistory throws", async () => {
      const client = createMockClient({
        handleFetchHistory: async () => {
          throw new Error("History not available");
        },
      });

      const adapter = createTemporalAdminAdapter(client);
      const result = await adapter.views.getWorkflow("wf-test-1");

      expect(result.ok).toBe(true);
      if (result.ok && result.value !== undefined) {
        expect(result.value.timeline).toBeUndefined();
      }
    });

    test("filters out non-interesting event types from timeline", async () => {
      const client = createMockClient({
        handleFetchHistory: async () => ({
          events: [
            {
              eventType: "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED",
              eventTime: new Date("2026-01-15T10:00:00Z"),
            },
            {
              eventType: "EVENT_TYPE_WORKFLOW_TASK_SCHEDULED",
              eventTime: new Date("2026-01-15T10:00:00Z"),
            },
            {
              eventType: "EVENT_TYPE_WORKFLOW_TASK_STARTED",
              eventTime: new Date("2026-01-15T10:00:00Z"),
            },
            {
              eventType: "EVENT_TYPE_WORKFLOW_TASK_COMPLETED",
              eventTime: new Date("2026-01-15T10:00:00Z"),
            },
          ],
        }),
      });

      const adapter = createTemporalAdminAdapter(client);
      const result = await adapter.views.getWorkflow("wf-test-1");

      expect(result.ok).toBe(true);
      if (result.ok && result.value !== undefined) {
        // Only the STARTED event should be in the timeline
        // Workflow task events are internal and filtered out
        expect(result.value.timeline).toHaveLength(1);
        expect(result.value.timeline?.[0]?.label).toBe("Workflow started");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: getHealth
  // ---------------------------------------------------------------------------

  describe("views.getHealth", () => {
    test("returns healthy status with latency measurement", async () => {
      const client = createMockClient({
        healthCheckFn: async () => {
          // Simulate a small delay
        },
      });

      const adapter = createTemporalAdminAdapter(client, {
        namespace: "test-ns",
        serverAddress: "localhost:7233",
      });

      const health = await adapter.views.getHealth();

      expect(health.healthy).toBe(true);
      expect(health.namespace).toBe("test-ns");
      expect(health.serverAddress).toBe("localhost:7233");
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });

    test("returns unhealthy status when health check fails", async () => {
      const client = createMockClient({
        healthCheckFn: async () => {
          throw new Error("Connection refused");
        },
      });

      const adapter = createTemporalAdminAdapter(client, {
        namespace: "test-ns",
        serverAddress: "localhost:7233",
      });

      const health = await adapter.views.getHealth();

      expect(health.healthy).toBe(false);
      expect(health.namespace).toBe("test-ns");
      expect(health.serverAddress).toBe("localhost:7233");
      expect(health.latencyMs).toBeUndefined();
    });

    test("uses default namespace and serverAddress when options omitted", async () => {
      const client = createMockClient();
      const adapter = createTemporalAdminAdapter(client);

      const health = await adapter.views.getHealth();

      expect(health.namespace).toBe("default");
      expect(health.serverAddress).toBe("localhost:7233");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: signalWorkflow
  // ---------------------------------------------------------------------------

  describe("commands.signalWorkflow", () => {
    test("returns ok Result on successful signal", async () => {
      let capturedSignal = "";
      let capturedArgs: readonly unknown[] = [];

      const client = createMockClient({
        handleSignal: async (signalName: string, ...args: readonly unknown[]) => {
          capturedSignal = signalName;
          capturedArgs = args;
        },
      });

      const adapter = createTemporalAdminAdapter(client);
      const result = await adapter.commands.signalWorkflow("wf-1", "mySignal", { data: 42 });

      expect(result.ok).toBe(true);
      expect(capturedSignal).toBe("mySignal");
      expect(capturedArgs).toEqual([{ data: 42 }]);
    });

    test("returns error Result when signal throws", async () => {
      const client = createMockClient({
        handleSignal: async () => {
          throw new Error("Workflow not found");
        },
      });

      const adapter = createTemporalAdminAdapter(client);
      const result = await adapter.commands.signalWorkflow("wf-1", "mySignal", {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("EXTERNAL");
        expect(result.error.message).toContain("Workflow not found");
        expect(result.error.retryable).toBe(false);
        expect(result.error.context).toEqual({ workflowId: "wf-1", signal: "mySignal" });
      }
    });

    test("handles non-Error thrown values", async () => {
      const client = createMockClient({
        handleSignal: async () => {
          throw "string error";
        },
      });

      const adapter = createTemporalAdminAdapter(client);
      const result = await adapter.commands.signalWorkflow("wf-1", "test", null);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("string error");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: terminateWorkflow
  // ---------------------------------------------------------------------------

  describe("commands.terminateWorkflow", () => {
    test("returns ok Result on successful termination", async () => {
      let terminateCalled = false;

      const client = createMockClient({
        handleTerminate: async () => {
          terminateCalled = true;
        },
      });

      const adapter = createTemporalAdminAdapter(client);
      const result = await adapter.commands.terminateWorkflow("wf-1");

      expect(result.ok).toBe(true);
      expect(terminateCalled).toBe(true);
    });

    test("returns error Result when terminate throws", async () => {
      const client = createMockClient({
        handleTerminate: async () => {
          throw new Error("Permission denied");
        },
      });

      const adapter = createTemporalAdminAdapter(client);
      const result = await adapter.commands.terminateWorkflow("wf-1");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("EXTERNAL");
        expect(result.error.message).toContain("Permission denied");
        expect(result.error.retryable).toBe(false);
        expect(result.error.context).toEqual({ workflowId: "wf-1" });
      }
    });

    test("handles non-Error thrown values", async () => {
      const client = createMockClient({
        handleTerminate: async () => {
          throw 42;
        },
      });

      const adapter = createTemporalAdminAdapter(client);
      const result = await adapter.commands.terminateWorkflow("wf-1");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("42");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: return type shape
  // ---------------------------------------------------------------------------

  describe("return type shape", () => {
    test("views matches RuntimeViewDataSource temporal shape", () => {
      const client = createMockClient();
      const adapter = createTemporalAdminAdapter(client);

      // Verify all required view methods exist
      expect(typeof adapter.views.getHealth).toBe("function");
      expect(typeof adapter.views.listWorkflows).toBe("function");
      expect(typeof adapter.views.getWorkflow).toBe("function");
    });

    test("commands matches Pick<CommandDispatcher, signalWorkflow | terminateWorkflow>", () => {
      const client = createMockClient();
      const adapter = createTemporalAdminAdapter(client);

      expect(typeof adapter.commands.signalWorkflow).toBe("function");
      expect(typeof adapter.commands.terminateWorkflow).toBe("function");
    });
  });
});
