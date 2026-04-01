/**
 * Orchestration route unit tests — Temporal, Scheduler, Task Board, Harness.
 */

import { describe, expect, test } from "bun:test";
import type { KoiError, KoiErrorCode, Result } from "@koi/core";
import type {
  CheckpointEntry,
  CommandDispatcher,
  CronSchedule,
  HarnessStatus,
  RuntimeViewDataSource,
  SchedulerDeadLetterEntry,
  SchedulerStats,
  SchedulerTaskSummary,
  TaskBoardSnapshot,
  TemporalHealth,
  WorkflowDetail,
  WorkflowSummary,
} from "@koi/dashboard-types";
import {
  handleDeleteSchedule,
  handleHarnessCheckpoints,
  handleHarnessStatus,
  handlePauseHarness,
  handlePauseSchedule,
  handleResumeHarness,
  handleResumeSchedule,
  handleRetrySchedulerDlq,
  handleSchedulerDlq,
  handleSchedulerSchedules,
  handleSchedulerStats,
  handleSchedulerTasks,
  handleSignalWorkflow,
  handleTaskBoard,
  handleTemporalHealth,
  handleTemporalWorkflow,
  handleTemporalWorkflows,
  handleTerminateWorkflow,
} from "./orchestration.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(): Result<void, KoiError> {
  return { ok: true, value: undefined };
}

function err(code: KoiErrorCode, message: string): Result<void, KoiError> {
  return {
    ok: false,
    error: { code, message, retryable: false, context: {} },
  };
}

function makeReq(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init);
}

function makePostReq(url: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_TEMPORAL_HEALTH: TemporalHealth = {
  healthy: true,
  serverAddress: "localhost:7233",
  namespace: "default",
  latencyMs: 5,
};

const MOCK_WORKFLOW_SUMMARY: WorkflowSummary = {
  workflowId: "wf-1",
  workflowType: "agentLoop",
  status: "running",
  startTime: Date.now() - 60_000,
  taskQueue: "koi-tasks",
};

const MOCK_WORKFLOW_DETAIL: WorkflowDetail = {
  ...MOCK_WORKFLOW_SUMMARY,
  runId: "run-abc-123",
  searchAttributes: {},
  memo: {},
  pendingActivities: 2,
  pendingSignals: 0,
  canCount: 0,
};

const MOCK_SCHEDULER_TASK: SchedulerTaskSummary = {
  taskId: "task-1",
  agentId: "agent-1",
  status: "running",
  priority: 10,
  submittedAt: Date.now() - 30_000,
  startedAt: Date.now() - 20_000,
  retryCount: 0,
};

const MOCK_SCHEDULER_STATS: SchedulerStats = {
  submitted: 100,
  completed: 80,
  failed: 5,
  deadLetterCount: 3,
  concurrencyLimit: 10,
  currentConcurrency: 4,
};

const MOCK_CRON_SCHEDULE: CronSchedule = {
  scheduleId: "sched-1",
  pattern: "*/5 * * * *",
  nextFireTime: Date.now() + 300_000,
  active: true,
  description: "Every 5 minutes",
};

const MOCK_DLQ_ENTRY: SchedulerDeadLetterEntry = {
  entryId: "dlq-1",
  taskId: "task-99",
  failedAt: Date.now() - 10_000,
  error: "Timeout exceeded",
  retryCount: 3,
};

const MOCK_TASK_BOARD_SNAPSHOT: TaskBoardSnapshot = {
  nodes: [
    { taskId: "t1", label: "step-1", status: "completed" },
    { taskId: "t2", label: "step-2", status: "running", assignedTo: "agent-1" },
  ],
  edges: [{ from: "t1", to: "t2" }],
  timestamp: Date.now(),
};

const MOCK_HARNESS_STATUS: HarnessStatus = {
  phase: "running",
  sessionCount: 3,
  taskProgress: { completed: 7, total: 10 },
  tokenUsage: { used: 15_000, budget: 50_000 },
  autoResumeEnabled: true,
  startedAt: Date.now() - 120_000,
};

const MOCK_CHECKPOINT: CheckpointEntry = {
  id: "cp-1",
  type: "soft",
  createdAt: Date.now() - 5_000,
  sessionId: "sess-1",
  metadata: { reason: "token-limit" },
};

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/** Keys of optional orchestration subsystems on RuntimeViewDataSource. */
type OptionalSubsystem = "temporal" | "scheduler" | "taskBoard" | "harness";

function createMockViews(options?: {
  readonly without?: readonly OptionalSubsystem[];
}): RuntimeViewDataSource {
  const base: RuntimeViewDataSource = {
    getProcessTree: () => ({ roots: [], totalAgents: 0, timestamp: Date.now() }),
    getAgentProcfs: () => undefined,
    getMiddlewareChain: (id) => ({ agentId: id, entries: [] }),
    getGatewayTopology: () => ({ connections: [], nodeCount: 0, timestamp: Date.now() }),
    temporal: {
      getHealth: () => MOCK_TEMPORAL_HEALTH,
      listWorkflows: async () => [MOCK_WORKFLOW_SUMMARY],
      getWorkflow: async (id) =>
        id === "wf-1" ? { ok: true, value: MOCK_WORKFLOW_DETAIL } : { ok: true, value: undefined },
    },
    scheduler: {
      listTasks: async () => [MOCK_SCHEDULER_TASK],
      getStats: () => MOCK_SCHEDULER_STATS,
      listSchedules: async () => [MOCK_CRON_SCHEDULE],
      listDeadLetters: async () => [MOCK_DLQ_ENTRY],
    },
    taskBoard: {
      getSnapshot: () => MOCK_TASK_BOARD_SNAPSHOT,
    },
    harness: {
      getStatus: () => MOCK_HARNESS_STATUS,
      getCheckpoints: async () => [MOCK_CHECKPOINT],
    },
  };

  if (options?.without !== undefined) {
    // Remove specified subsystems by destructuring to a new object
    const result = { ...base };
    for (const key of options.without) {
      delete (result as Record<string, unknown>)[key];
    }
    return result;
  }

  return base;
}

function createMockCommands(overrides?: Partial<CommandDispatcher>): CommandDispatcher {
  return {
    suspendAgent: () => ok(),
    resumeAgent: () => ok(),
    terminateAgent: () => ok(),
    signalWorkflow: async () => ok(),
    terminateWorkflow: async () => ok(),
    pauseSchedule: async () => ok(),
    resumeSchedule: async () => ok(),
    deleteSchedule: async () => ok(),
    retrySchedulerDeadLetter: async () => ok(),
    pauseHarness: async () => ok(),
    resumeHarness: async () => ok(),
    ...overrides,
  };
}

// =========================================================================
// Temporal views
// =========================================================================

describe("handleTemporalHealth", () => {
  test("returns 501 when temporal is not configured", async () => {
    const views = createMockViews({ without: ["temporal"] });
    const res = await handleTemporalHealth(makeReq("/view/temporal/health"), {}, views);
    expect(res.status).toBe(501);
  });

  test("returns temporal health on success", async () => {
    const views = createMockViews();
    const res = await handleTemporalHealth(makeReq("/view/temporal/health"), {}, views);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body.data as Record<string, unknown>;
    expect(data.healthy).toBe(true);
    expect(data.serverAddress).toBe("localhost:7233");
    expect(data.namespace).toBe("default");
  });
});

describe("handleTemporalWorkflows", () => {
  test("returns 501 when temporal is not configured", async () => {
    const views = createMockViews({ without: ["temporal"] });
    const res = await handleTemporalWorkflows(makeReq("/view/temporal/workflows"), {}, views);
    expect(res.status).toBe(501);
  });

  test("returns workflow list on success", async () => {
    const views = createMockViews();
    const res = await handleTemporalWorkflows(makeReq("/view/temporal/workflows"), {}, views);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body.data as readonly unknown[];
    expect(data).toHaveLength(1);
    expect((data[0] as Record<string, unknown>).workflowId).toBe("wf-1");
  });
});

describe("handleTemporalWorkflow", () => {
  test("returns 501 when temporal is not configured", async () => {
    const views = createMockViews({ without: ["temporal"] });
    const res = await handleTemporalWorkflow(
      makeReq("/view/temporal/workflows/wf-1"),
      { id: "wf-1" },
      views,
    );
    expect(res.status).toBe(501);
  });

  test("returns 400 when id is missing", async () => {
    const views = createMockViews();
    const res = await handleTemporalWorkflow(makeReq("/view/temporal/workflows/"), {}, views);
    expect(res.status).toBe(400);
  });

  test("returns 404 when workflow not found", async () => {
    const views = createMockViews();
    const res = await handleTemporalWorkflow(
      makeReq("/view/temporal/workflows/nonexistent"),
      { id: "nonexistent" },
      views,
    );
    expect(res.status).toBe(404);
  });

  test("returns workflow detail on success", async () => {
    const views = createMockViews();
    const res = await handleTemporalWorkflow(
      makeReq("/view/temporal/workflows/wf-1"),
      { id: "wf-1" },
      views,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body.data as Record<string, unknown>;
    expect(data.workflowId).toBe("wf-1");
    expect(data.runId).toBe("run-abc-123");
    expect(data.pendingActivities).toBe(2);
  });

  test("returns 502 when getWorkflow returns an error result", async () => {
    const views: RuntimeViewDataSource = {
      ...createMockViews(),
      temporal: {
        getHealth: () => MOCK_TEMPORAL_HEALTH,
        listWorkflows: async () => [MOCK_WORKFLOW_SUMMARY],
        getWorkflow: async () => ({
          ok: false,
          error: {
            code: "EXTERNAL",
            message: "Connection refused: Temporal server unavailable",
            retryable: true,
            context: {},
          },
        }),
      },
    };
    const res = await handleTemporalWorkflow(
      makeReq("/view/temporal/workflows/wf-1"),
      { id: "wf-1" },
      views,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    const error = body.error as Record<string, unknown>;
    expect(error.code).toBe("EXTERNAL");
    expect(error.message).toContain("Connection refused");
  });
});

// =========================================================================
// Scheduler views
// =========================================================================

describe("handleSchedulerTasks", () => {
  test("returns 501 when scheduler is not configured", async () => {
    const views = createMockViews({ without: ["scheduler"] });
    const res = await handleSchedulerTasks(makeReq("/view/scheduler/tasks"), {}, views);
    expect(res.status).toBe(501);
  });

  test("returns task list on success", async () => {
    const views = createMockViews();
    const res = await handleSchedulerTasks(makeReq("/view/scheduler/tasks"), {}, views);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body.data as readonly unknown[];
    expect(data).toHaveLength(1);
    expect((data[0] as Record<string, unknown>).taskId).toBe("task-1");
  });
});

describe("handleSchedulerStats", () => {
  test("returns 501 when scheduler is not configured", async () => {
    const views = createMockViews({ without: ["scheduler"] });
    const res = await handleSchedulerStats(makeReq("/view/scheduler/stats"), {}, views);
    expect(res.status).toBe(501);
  });

  test("returns scheduler stats on success", async () => {
    const views = createMockViews();
    const res = await handleSchedulerStats(makeReq("/view/scheduler/stats"), {}, views);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body.data as Record<string, unknown>;
    expect(data.submitted).toBe(100);
    expect(data.completed).toBe(80);
    expect(data.failed).toBe(5);
    expect(data.deadLetterCount).toBe(3);
    expect(data.currentConcurrency).toBe(4);
  });
});

describe("handleSchedulerSchedules", () => {
  test("returns 501 when scheduler is not configured", async () => {
    const views = createMockViews({ without: ["scheduler"] });
    const res = await handleSchedulerSchedules(makeReq("/view/scheduler/schedules"), {}, views);
    expect(res.status).toBe(501);
  });

  test("returns cron schedules on success", async () => {
    const views = createMockViews();
    const res = await handleSchedulerSchedules(makeReq("/view/scheduler/schedules"), {}, views);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body.data as readonly unknown[];
    expect(data).toHaveLength(1);
    expect((data[0] as Record<string, unknown>).scheduleId).toBe("sched-1");
    expect((data[0] as Record<string, unknown>).active).toBe(true);
  });
});

describe("handleSchedulerDlq", () => {
  test("returns 501 when scheduler is not configured", async () => {
    const views = createMockViews({ without: ["scheduler"] });
    const res = await handleSchedulerDlq(makeReq("/view/scheduler/dlq"), {}, views);
    expect(res.status).toBe(501);
  });

  test("returns dead letter entries on success", async () => {
    const views = createMockViews();
    const res = await handleSchedulerDlq(makeReq("/view/scheduler/dlq"), {}, views);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body.data as readonly unknown[];
    expect(data).toHaveLength(1);
    expect((data[0] as Record<string, unknown>).entryId).toBe("dlq-1");
    expect((data[0] as Record<string, unknown>).error).toBe("Timeout exceeded");
  });
});

// =========================================================================
// Task board views
// =========================================================================

describe("handleTaskBoard", () => {
  test("returns 501 when task board is not configured", async () => {
    const views = createMockViews({ without: ["taskBoard"] });
    const res = await handleTaskBoard(makeReq("/view/taskboard"), {}, views);
    expect(res.status).toBe(501);
  });

  test("returns task board snapshot on success", async () => {
    const views = createMockViews();
    const res = await handleTaskBoard(makeReq("/view/taskboard"), {}, views);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body.data as Record<string, unknown>;
    expect((data.nodes as readonly unknown[]).length).toBe(2);
    expect((data.edges as readonly unknown[]).length).toBe(1);
  });
});

// =========================================================================
// Harness views
// =========================================================================

describe("handleHarnessStatus", () => {
  test("returns 501 when harness is not configured", async () => {
    const views = createMockViews({ without: ["harness"] });
    const res = await handleHarnessStatus(makeReq("/view/harness/status"), {}, views);
    expect(res.status).toBe(501);
  });

  test("returns harness status on success", async () => {
    const views = createMockViews();
    const res = await handleHarnessStatus(makeReq("/view/harness/status"), {}, views);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body.data as Record<string, unknown>;
    expect(data.phase).toBe("running");
    expect(data.sessionCount).toBe(3);
    expect(data.autoResumeEnabled).toBe(true);
  });
});

describe("handleHarnessCheckpoints", () => {
  test("returns 501 when harness is not configured", async () => {
    const views = createMockViews({ without: ["harness"] });
    const res = await handleHarnessCheckpoints(makeReq("/view/harness/checkpoints"), {}, views);
    expect(res.status).toBe(501);
  });

  test("returns checkpoint entries on success", async () => {
    const views = createMockViews();
    const res = await handleHarnessCheckpoints(makeReq("/view/harness/checkpoints"), {}, views);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const data = body.data as readonly unknown[];
    expect(data).toHaveLength(1);
    expect((data[0] as Record<string, unknown>).id).toBe("cp-1");
    expect((data[0] as Record<string, unknown>).type).toBe("soft");
  });
});

// =========================================================================
// Orchestration commands — Temporal
// =========================================================================

describe("handleSignalWorkflow", () => {
  test("returns 501 when signalWorkflow is not implemented", async () => {
    const { signalWorkflow: _, ...rest } = createMockCommands();
    const res = await handleSignalWorkflow(
      makePostReq("/cmd/temporal/workflows/wf-1/signal", { signal: "resume" }),
      { id: "wf-1" },
      rest as CommandDispatcher,
    );
    expect(res.status).toBe(501);
  });

  test("returns 400 when id is missing", async () => {
    const commands = createMockCommands();
    const res = await handleSignalWorkflow(
      makePostReq("/cmd/temporal/workflows//signal", { signal: "resume" }),
      {},
      commands,
    );
    expect(res.status).toBe(400);
  });

  test("returns 400 when body is invalid JSON", async () => {
    const commands = createMockCommands();
    const req = new Request("http://localhost/cmd/temporal/workflows/wf-1/signal", {
      method: "POST",
      body: "not valid json",
      headers: { "content-type": "application/json" },
    });
    const res = await handleSignalWorkflow(req, { id: "wf-1" }, commands);
    expect(res.status).toBe(400);
  });

  test("returns 400 when signal field is missing", async () => {
    const commands = createMockCommands();
    const res = await handleSignalWorkflow(
      makePostReq("/cmd/temporal/workflows/wf-1/signal", { payload: "data" }),
      { id: "wf-1" },
      commands,
    );
    expect(res.status).toBe(400);
  });

  test("returns 200 on success", async () => {
    const commands = createMockCommands();
    const res = await handleSignalWorkflow(
      makePostReq("/cmd/temporal/workflows/wf-1/signal", {
        signal: "resume",
        payload: { reason: "user-request" },
      }),
      { id: "wf-1" },
      commands,
    );
    expect(res.status).toBe(200);
  });

  test("returns 404 when workflow not found", async () => {
    const commands = createMockCommands({
      signalWorkflow: async () => err("NOT_FOUND", "Workflow not found"),
    });
    const res = await handleSignalWorkflow(
      makePostReq("/cmd/temporal/workflows/wf-missing/signal", { signal: "resume" }),
      { id: "wf-missing" },
      commands,
    );
    expect(res.status).toBe(404);
  });

  test("returns 500 on internal error", async () => {
    const commands = createMockCommands({
      signalWorkflow: async () => err("INTERNAL", "Temporal unavailable"),
    });
    const res = await handleSignalWorkflow(
      makePostReq("/cmd/temporal/workflows/wf-1/signal", { signal: "resume" }),
      { id: "wf-1" },
      commands,
    );
    expect(res.status).toBe(500);
  });
});

describe("handleTerminateWorkflow", () => {
  test("returns 501 when terminateWorkflow is not implemented", async () => {
    const { terminateWorkflow: _, ...rest } = createMockCommands();
    const res = await handleTerminateWorkflow(
      makePostReq("/cmd/temporal/workflows/wf-1/terminate"),
      { id: "wf-1" },
      rest as CommandDispatcher,
    );
    expect(res.status).toBe(501);
  });

  test("returns 400 when id is missing", async () => {
    const commands = createMockCommands();
    const res = await handleTerminateWorkflow(
      makePostReq("/cmd/temporal/workflows//terminate"),
      {},
      commands,
    );
    expect(res.status).toBe(400);
  });

  test("returns 200 on success", async () => {
    const commands = createMockCommands();
    const res = await handleTerminateWorkflow(
      makePostReq("/cmd/temporal/workflows/wf-1/terminate"),
      { id: "wf-1" },
      commands,
    );
    expect(res.status).toBe(200);
  });

  test("returns 404 when workflow not found", async () => {
    const commands = createMockCommands({
      terminateWorkflow: async () => err("NOT_FOUND", "Workflow not found"),
    });
    const res = await handleTerminateWorkflow(
      makePostReq("/cmd/temporal/workflows/wf-missing/terminate"),
      { id: "wf-missing" },
      commands,
    );
    expect(res.status).toBe(404);
  });
});

// =========================================================================
// Orchestration commands — Scheduler
// =========================================================================

describe("handlePauseSchedule", () => {
  test("returns 501 when pauseSchedule is not implemented", async () => {
    const { pauseSchedule: _, ...rest } = createMockCommands();
    const res = await handlePauseSchedule(
      makePostReq("/cmd/scheduler/schedules/s1/pause"),
      { id: "s1" },
      rest as CommandDispatcher,
    );
    expect(res.status).toBe(501);
  });

  test("returns 400 when id is missing", async () => {
    const commands = createMockCommands();
    const res = await handlePauseSchedule(
      makePostReq("/cmd/scheduler/schedules//pause"),
      {},
      commands,
    );
    expect(res.status).toBe(400);
  });

  test("returns 200 on success", async () => {
    const commands = createMockCommands();
    const res = await handlePauseSchedule(
      makePostReq("/cmd/scheduler/schedules/s1/pause"),
      { id: "s1" },
      commands,
    );
    expect(res.status).toBe(200);
  });

  test("returns 404 when schedule not found", async () => {
    const commands = createMockCommands({
      pauseSchedule: async () => err("NOT_FOUND", "Schedule not found"),
    });
    const res = await handlePauseSchedule(
      makePostReq("/cmd/scheduler/schedules/s-missing/pause"),
      { id: "s-missing" },
      commands,
    );
    expect(res.status).toBe(404);
  });
});

describe("handleResumeSchedule", () => {
  test("returns 501 when resumeSchedule is not implemented", async () => {
    const { resumeSchedule: _, ...rest } = createMockCommands();
    const res = await handleResumeSchedule(
      makePostReq("/cmd/scheduler/schedules/s1/resume"),
      { id: "s1" },
      rest as CommandDispatcher,
    );
    expect(res.status).toBe(501);
  });

  test("returns 400 when id is missing", async () => {
    const commands = createMockCommands();
    const res = await handleResumeSchedule(
      makePostReq("/cmd/scheduler/schedules//resume"),
      {},
      commands,
    );
    expect(res.status).toBe(400);
  });

  test("returns 200 on success", async () => {
    const commands = createMockCommands();
    const res = await handleResumeSchedule(
      makePostReq("/cmd/scheduler/schedules/s1/resume"),
      { id: "s1" },
      commands,
    );
    expect(res.status).toBe(200);
  });

  test("returns 404 when schedule not found", async () => {
    const commands = createMockCommands({
      resumeSchedule: async () => err("NOT_FOUND", "Schedule not found"),
    });
    const res = await handleResumeSchedule(
      makePostReq("/cmd/scheduler/schedules/s-missing/resume"),
      { id: "s-missing" },
      commands,
    );
    expect(res.status).toBe(404);
  });
});

describe("handleDeleteSchedule", () => {
  test("returns 501 when deleteSchedule is not implemented", async () => {
    const { deleteSchedule: _, ...rest } = createMockCommands();
    const res = await handleDeleteSchedule(
      makePostReq("/cmd/scheduler/schedules/s1/delete"),
      { id: "s1" },
      rest as CommandDispatcher,
    );
    expect(res.status).toBe(501);
  });

  test("returns 400 when id is missing", async () => {
    const commands = createMockCommands();
    const res = await handleDeleteSchedule(
      makePostReq("/cmd/scheduler/schedules//delete"),
      {},
      commands,
    );
    expect(res.status).toBe(400);
  });

  test("returns 200 on success", async () => {
    const commands = createMockCommands();
    const res = await handleDeleteSchedule(
      makePostReq("/cmd/scheduler/schedules/s1/delete"),
      { id: "s1" },
      commands,
    );
    expect(res.status).toBe(200);
  });

  test("returns 404 when schedule not found", async () => {
    const commands = createMockCommands({
      deleteSchedule: async () => err("NOT_FOUND", "Schedule not found"),
    });
    const res = await handleDeleteSchedule(
      makePostReq("/cmd/scheduler/schedules/s-missing/delete"),
      { id: "s-missing" },
      commands,
    );
    expect(res.status).toBe(404);
  });
});

describe("handleRetrySchedulerDlq", () => {
  test("returns 501 when retrySchedulerDeadLetter is not implemented", async () => {
    const { retrySchedulerDeadLetter: _, ...rest } = createMockCommands();
    const res = await handleRetrySchedulerDlq(
      makePostReq("/cmd/scheduler/dlq/dlq-1/retry"),
      { id: "dlq-1" },
      rest as CommandDispatcher,
    );
    expect(res.status).toBe(501);
  });

  test("returns 400 when id is missing", async () => {
    const commands = createMockCommands();
    const res = await handleRetrySchedulerDlq(
      makePostReq("/cmd/scheduler/dlq//retry"),
      {},
      commands,
    );
    expect(res.status).toBe(400);
  });

  test("returns 200 on success", async () => {
    const commands = createMockCommands();
    const res = await handleRetrySchedulerDlq(
      makePostReq("/cmd/scheduler/dlq/dlq-1/retry"),
      { id: "dlq-1" },
      commands,
    );
    expect(res.status).toBe(200);
  });

  test("returns 404 when dead letter entry not found", async () => {
    const commands = createMockCommands({
      retrySchedulerDeadLetter: async () => err("NOT_FOUND", "Entry not found"),
    });
    const res = await handleRetrySchedulerDlq(
      makePostReq("/cmd/scheduler/dlq/dlq-missing/retry"),
      { id: "dlq-missing" },
      commands,
    );
    expect(res.status).toBe(404);
  });
});

// =========================================================================
// Orchestration commands — Harness
// =========================================================================

describe("handlePauseHarness", () => {
  test("returns 501 when pauseHarness is not implemented", async () => {
    const { pauseHarness: _, ...rest } = createMockCommands();
    const res = await handlePauseHarness(
      makePostReq("/cmd/harness/pause"),
      {},
      rest as CommandDispatcher,
    );
    expect(res.status).toBe(501);
  });

  test("returns 200 on success", async () => {
    const commands = createMockCommands();
    const res = await handlePauseHarness(makePostReq("/cmd/harness/pause"), {}, commands);
    expect(res.status).toBe(200);
  });

  test("returns 500 on internal error", async () => {
    const commands = createMockCommands({
      pauseHarness: async () => err("INTERNAL", "Harness not responding"),
    });
    const res = await handlePauseHarness(makePostReq("/cmd/harness/pause"), {}, commands);
    expect(res.status).toBe(500);
  });
});

describe("handleResumeHarness", () => {
  test("returns 501 when resumeHarness is not implemented", async () => {
    const { resumeHarness: _, ...rest } = createMockCommands();
    const res = await handleResumeHarness(
      makePostReq("/cmd/harness/resume"),
      {},
      rest as CommandDispatcher,
    );
    expect(res.status).toBe(501);
  });

  test("returns 200 on success", async () => {
    const commands = createMockCommands();
    const res = await handleResumeHarness(makePostReq("/cmd/harness/resume"), {}, commands);
    expect(res.status).toBe(200);
  });

  test("returns 500 on internal error", async () => {
    const commands = createMockCommands({
      resumeHarness: async () => err("INTERNAL", "Harness not responding"),
    });
    const res = await handleResumeHarness(makePostReq("/cmd/harness/resume"), {}, commands);
    expect(res.status).toBe(500);
  });
});
