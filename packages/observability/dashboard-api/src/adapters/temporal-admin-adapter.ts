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

/** Minimal shape of a workflow handle returned by getHandle. */
interface TemporalWorkflowHandleLike {
  readonly describe: () => Promise<
    TemporalWorkflowExecutionLike & {
      readonly pendingActivities: readonly unknown[];
    }
  >;
  readonly signal: (signalName: string, ...args: readonly unknown[]) => Promise<void>;
  readonly terminate: (reason?: string) => Promise<void>;
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

function mapToKoiError(e: unknown, context: Readonly<Record<string, unknown>>): KoiError {
  const message = e instanceof Error ? e.message : String(e);
  return {
    code: "EXTERNAL",
    message,
    retryable: false,
    cause: e,
    context,
  };
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapExecutionToSummary(exec: TemporalWorkflowExecutionLike): WorkflowSummary {
  const base = {
    workflowId: exec.workflowId,
    workflowType: exec.type.name,
    status: mapStatus(exec.status.name),
    startTime: exec.startTime.getTime(),
    taskQueue: exec.taskQueue,
  } as const;

  if (exec.closeTime !== null) {
    return { ...base, closeTime: exec.closeTime.getTime() };
  }
  return base;
}

function mapDescriptionToDetail(
  desc: TemporalWorkflowExecutionLike & { readonly pendingActivities: readonly unknown[] },
): WorkflowDetail {
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

  const getWorkflow = async (id: string): Promise<WorkflowDetail | undefined> => {
    try {
      const handle = client.workflow.getHandle(id);
      const desc = await handle.describe();
      return mapDescriptionToDetail(desc);
    } catch {
      return undefined;
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
