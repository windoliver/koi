/**
 * Temporal admin adapter for the Koi dashboard.
 *
 * Wraps a structurally-typed Temporal client to produce dashboard-compatible
 * views (RuntimeViewDataSource['temporal']) and commands (signalWorkflow,
 * terminateWorkflow). Uses structural typing to avoid direct dependency on
 * @temporalio/client — the consumer injects a compatible client at runtime.
 *
 * L2 package: imports from @koi/core and @koi/dashboard-types only.
 */

import type { KoiError, Result } from "@koi/core";
import type {
  CommandDispatcher,
  RuntimeViewDataSource,
  TemporalHealth,
  TimelineEvent,
  WorkflowDetail,
  WorkflowSummary,
} from "@koi/dashboard-types";

// ---------------------------------------------------------------------------
// Structural types (loose coupling — no @temporalio/client import)
// ---------------------------------------------------------------------------

/** Minimal shape of a workflow execution returned by the Temporal SDK list API. */
export interface TemporalWorkflowExecutionLike {
  readonly workflowId: string;
  readonly type: { readonly name: string };
  readonly status: { readonly name: string };
  readonly startTime: Date;
  readonly closeTime: Date | null;
  readonly taskQueue: string;
  readonly runId: string;
  readonly searchAttributes: Readonly<Record<string, unknown>>;
  readonly memo: Readonly<Record<string, unknown>>;
}

/** Shape returned by handle.describe() including pending state. */
interface TemporalWorkflowDescriptionLike extends TemporalWorkflowExecutionLike {
  readonly pendingActivities: readonly unknown[];
  /** Pending signals (Temporal SDK >= 1.9). May be absent on older servers. */
  readonly pendingNexusOperations?: readonly unknown[];
}

/** Minimal shape of a history event returned by fetchHistory(). */
interface TemporalHistoryEventLike {
  readonly eventType: string;
  readonly eventTime: Date;
  readonly [key: string]: unknown;
}

/** Minimal shape of the history returned by fetchHistory(). */
interface TemporalHistoryLike {
  readonly events: readonly TemporalHistoryEventLike[];
}

/** Minimal shape of a workflow handle returned by getHandle. */
interface TemporalWorkflowHandleLike {
  readonly describe: () => Promise<TemporalWorkflowDescriptionLike>;
  readonly signal: (signalName: string, ...args: readonly unknown[]) => Promise<void>;
  readonly terminate: (reason?: string) => Promise<void>;
  readonly query: (queryType: string) => Promise<unknown>;
  readonly fetchHistory: () => Promise<TemporalHistoryLike>;
}

/** Async iterable returned by workflow.list(). */
interface TemporalWorkflowListLike {
  readonly [Symbol.asyncIterator]: () => AsyncIterator<TemporalWorkflowExecutionLike>;
}

/**
 * Structural type for the Temporal admin client.
 *
 * Mirrors the subset of `@temporalio/client.Client` needed for admin queries.
 * Does NOT import from `@temporalio/client` — the consumer provides a
 * compatible instance at runtime.
 */
export interface TemporalAdminClientLike {
  readonly workflow: {
    readonly list: () => TemporalWorkflowListLike;
    readonly getHandle: (workflowId: string) => TemporalWorkflowHandleLike;
  };
  readonly connection: {
    readonly healthCheck: () => Promise<void>;
  };
}

/** Options for the temporal admin adapter factory. */
export interface TemporalAdminAdapterOptions {
  readonly namespace?: string;
  readonly serverAddress?: string;
}

/** Return type of createTemporalAdminAdapter. */
export interface TemporalAdminAdapter {
  readonly views: NonNullable<RuntimeViewDataSource["temporal"]>;
  readonly commands: Required<Pick<CommandDispatcher, "signalWorkflow" | "terminateWorkflow">>;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

type WorkflowStatus = WorkflowSummary["status"];

const STATUS_MAP: Readonly<Record<string, WorkflowStatus>> = Object.freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TERMINATED: "terminated",
  TIMED_OUT: "timed_out",
});

function mapStatus(sdkStatus: string): WorkflowStatus {
  return STATUS_MAP[sdkStatus] ?? "failed";
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapToKoiError(
  e: unknown,
  context: Readonly<Record<string, unknown>>,
  retryable = false,
): KoiError {
  const message = e instanceof Error ? e.message : String(e);
  return {
    code: "EXTERNAL",
    message,
    retryable,
    cause: e,
    context,
  };
}

/**
 * Detect whether a Temporal error indicates "workflow not found" vs an
 * operational failure (server down, network timeout, etc.).
 *
 * Temporal SDK throws `WorkflowNotFoundError` whose message includes
 * "not found" — we use a message heuristic to avoid importing the SDK.
 */
function isWorkflowNotFoundError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message.toLowerCase();
  return msg.includes("workflow not found") || msg.includes("not found");
}

// ---------------------------------------------------------------------------
// History → Timeline mapping
// ---------------------------------------------------------------------------

/**
 * Temporal event types we extract for the timeline.
 * Maps SDK event type strings to human-readable labels + categories.
 */
const TIMELINE_EVENT_MAP: Readonly<
  Record<string, { readonly label: string; readonly category: TimelineEvent["category"] }>
> = {
  EVENT_TYPE_WORKFLOW_EXECUTION_STARTED: { label: "Workflow started", category: "lifecycle" },
  EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED: { label: "Workflow completed", category: "lifecycle" },
  EVENT_TYPE_WORKFLOW_EXECUTION_FAILED: { label: "Workflow failed", category: "error" },
  EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT: { label: "Workflow timed out", category: "error" },
  EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED: { label: "Workflow cancelled", category: "lifecycle" },
  EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED: { label: "Workflow terminated", category: "lifecycle" },
  EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW: {
    label: "Workflow continued-as-new",
    category: "lifecycle",
  },
  EVENT_TYPE_ACTIVITY_TASK_SCHEDULED: { label: "Activity scheduled", category: "activity" },
  EVENT_TYPE_ACTIVITY_TASK_COMPLETED: { label: "Activity completed", category: "activity" },
  EVENT_TYPE_ACTIVITY_TASK_FAILED: { label: "Activity failed", category: "error" },
  EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT: { label: "Activity timed out", category: "error" },
  EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED: { label: "Signal received", category: "signal" },
  EVENT_TYPE_TIMER_STARTED: { label: "Timer started", category: "timer" },
  EVENT_TYPE_TIMER_FIRED: { label: "Timer fired", category: "timer" },
};

function mapHistoryToTimeline(history: TemporalHistoryLike): readonly TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const evt of history.events) {
    const mapping = TIMELINE_EVENT_MAP[evt.eventType];
    if (mapping !== undefined) {
      let label = mapping.label;

      // Enrich signal events with signal name when available
      if (
        evt.eventType === "EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED" &&
        typeof evt.workflowExecutionSignaledEventAttributes === "object" &&
        evt.workflowExecutionSignaledEventAttributes !== null
      ) {
        const attrs = evt.workflowExecutionSignaledEventAttributes as {
          readonly signalName?: string;
        };
        if (attrs.signalName !== undefined) {
          label = `Signal: ${attrs.signalName}`;
        }
      }

      // Enrich activity events with activity type when available
      if (
        evt.eventType === "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED" &&
        typeof evt.activityTaskScheduledEventAttributes === "object" &&
        evt.activityTaskScheduledEventAttributes !== null
      ) {
        const attrs = evt.activityTaskScheduledEventAttributes as {
          readonly activityType?: { readonly name?: string };
        };
        if (attrs.activityType?.name !== undefined) {
          label = `Activity: ${attrs.activityType.name}`;
        }
      }

      events.push({
        time: evt.eventTime.getTime(),
        label,
        category: mapping.category,
      });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapExecutionToSummary(exec: TemporalWorkflowExecutionLike): WorkflowSummary {
  const entityType = inferEntityType(exec);
  const base = {
    workflowId: exec.workflowId,
    workflowType: exec.type.name,
    status: mapStatus(exec.status.name),
    startTime: exec.startTime.getTime(),
    taskQueue: exec.taskQueue,
    ...(entityType !== undefined ? { entityType } : {}),
  } as const;

  if (exec.closeTime !== null) {
    return { ...base, closeTime: exec.closeTime.getTime() };
  }
  return base;
}

/**
 * Infer entity type from search attributes or workflow type name.
 * Koi workflows store agentType in search attributes when available.
 */
function inferEntityType(desc: TemporalWorkflowExecutionLike): "copilot" | "worker" | undefined {
  const attrs = desc.searchAttributes;
  const agentType = attrs["KoiAgentType"] ?? attrs["agentType"];
  if (agentType === "copilot" || agentType === "worker") return agentType;

  // Heuristic: workflow type containing "worker" suggests worker agent
  const typeLower = desc.type.name.toLowerCase();
  if (typeLower.includes("worker")) return "worker";
  return undefined;
}

function mapDescriptionToDetail(
  desc: TemporalWorkflowDescriptionLike,
  stateRefs:
    | {
        readonly lastTurnId?: string;
        readonly turnsProcessed: number;
        readonly activityStatus?: string;
      }
    | undefined,
  pendingMessageCount: number,
  timeline: readonly TimelineEvent[] | undefined,
): WorkflowDetail {
  const entityType = inferEntityType(desc);
  const base = {
    workflowId: desc.workflowId,
    workflowType: desc.type.name,
    status: mapStatus(desc.status.name),
    startTime: desc.startTime.getTime(),
    taskQueue: desc.taskQueue,
    runId: desc.runId,
    searchAttributes: desc.searchAttributes,
    memo: desc.memo,
    pendingActivities: desc.pendingActivities.length,
    pendingSignals: pendingMessageCount,
    canCount: 0,
    ...(entityType !== undefined ? { entityType } : {}),
    ...(stateRefs !== undefined ? { stateRefs } : {}),
    ...(timeline !== undefined ? { timeline } : {}),
  } as const;

  if (desc.closeTime !== null) {
    return { ...base, closeTime: desc.closeTime.getTime() };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Temporal admin adapter for the dashboard.
 *
 * Returns views and commands that satisfy the RuntimeViewDataSource['temporal']
 * and CommandDispatcher shapes respectively.
 */
export function createTemporalAdminAdapter(
  client: TemporalAdminClientLike,
  options?: TemporalAdminAdapterOptions,
): TemporalAdminAdapter {
  const namespace = options?.namespace ?? "default";
  const serverAddress = options?.serverAddress ?? "localhost:7233";

  // -- Views ----------------------------------------------------------------

  const listWorkflows = async (): Promise<readonly WorkflowSummary[]> => {
    const summaries: WorkflowSummary[] = [];
    for await (const exec of client.workflow.list()) {
      summaries.push(mapExecutionToSummary(exec));
    }
    return summaries;
  };

  const getWorkflow = async (id: string): Promise<Result<WorkflowDetail | undefined, KoiError>> => {
    try {
      const handle = client.workflow.getHandle(id);
      const desc = await handle.describe();

      // Best-effort queries for state refs, activity status, pending count — non-fatal if unavailable
      let stateRefs:
        | {
            readonly lastTurnId?: string;
            readonly turnsProcessed: number;
            readonly activityStatus?: string;
          }
        | undefined;
      let pendingMessageCount = 0;

      // Query "getState" — agent state references (STATE_QUERY_NAME)
      try {
        const rawState = await handle.query("getState");
        if (
          rawState !== null &&
          rawState !== undefined &&
          typeof rawState === "object" &&
          "turnsProcessed" in rawState
        ) {
          const s = rawState as { lastTurnId?: string; turnsProcessed: number };
          stateRefs = {
            ...(s.lastTurnId !== undefined ? { lastTurnId: s.lastTurnId } : {}),
            turnsProcessed: s.turnsProcessed,
          };
        }
      } catch {
        // Query not available — workflow may not support it
      }

      // Query "getStatus" — activity status (STATUS_QUERY_NAME)
      try {
        const rawStatus = await handle.query("getStatus");
        if (typeof rawStatus === "string" && stateRefs !== undefined) {
          stateRefs = { ...stateRefs, activityStatus: rawStatus };
        }
      } catch {
        // Query not available
      }

      // Query "getPendingCount" — pending message count (PENDING_COUNT_QUERY_NAME)
      try {
        const rawCount = await handle.query("getPendingCount");
        if (typeof rawCount === "number") {
          pendingMessageCount = rawCount;
        }
      } catch {
        // Query not available
      }

      // Fetch workflow history for timeline — best-effort, non-fatal
      let timeline: readonly TimelineEvent[] | undefined;
      try {
        const history = await handle.fetchHistory();
        timeline = mapHistoryToTimeline(history);
      } catch {
        // History fetch not available — timeline will be undefined
      }

      return {
        ok: true,
        value: mapDescriptionToDetail(desc, stateRefs, pendingMessageCount, timeline),
      };
    } catch (e: unknown) {
      if (isWorkflowNotFoundError(e)) {
        return { ok: true, value: undefined };
      }
      return {
        ok: false,
        error: mapToKoiError(e, { workflowId: id }, true),
      };
    }
  };

  const getHealth = async (): Promise<TemporalHealth> => {
    const start = performance.now();
    try {
      await client.connection.healthCheck();
      const latencyMs = Math.round(performance.now() - start);
      return { healthy: true, serverAddress, namespace, latencyMs };
    } catch {
      return { healthy: false, serverAddress, namespace };
    }
  };

  const views: NonNullable<RuntimeViewDataSource["temporal"]> = {
    getHealth,
    listWorkflows,
    getWorkflow,
  };

  // -- Commands -------------------------------------------------------------

  const signalWorkflow = async (
    id: string,
    signal: string,
    payload: unknown,
  ): Promise<Result<void, KoiError>> => {
    try {
      const handle = client.workflow.getHandle(id);
      await handle.signal(signal, payload);
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return {
        ok: false,
        error: mapToKoiError(e, { workflowId: id, signal }),
      };
    }
  };

  const terminateWorkflow = async (id: string): Promise<Result<void, KoiError>> => {
    try {
      const handle = client.workflow.getHandle(id);
      await handle.terminate("Terminated via dashboard");
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return {
        ok: false,
        error: mapToKoiError(e, { workflowId: id }),
      };
    }
  };

  const commands: Required<Pick<CommandDispatcher, "signalWorkflow" | "terminateWorkflow">> = {
    signalWorkflow,
    terminateWorkflow,
  };

  return { views, commands };
}
