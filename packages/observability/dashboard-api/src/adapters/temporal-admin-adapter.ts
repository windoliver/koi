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

/** Shape returned by handle.describe() including pending state. */
interface TemporalWorkflowDescriptionLike extends TemporalWorkflowExecutionLike {
  readonly pendingActivities: readonly unknown[];
  /** Pending signals (Temporal SDK >= 1.9). May be absent on older servers. */
  readonly pendingNexusOperations?: readonly unknown[];
}

/** Minimal shape of a workflow handle returned by getHandle. */
interface TemporalWorkflowHandleLike {
  readonly describe: () => Promise<TemporalWorkflowDescriptionLike>;
  readonly signal: (signalName: string, ...args: readonly unknown[]) => Promise<void>;
  readonly terminate: (reason?: string) => Promise<void>;
  readonly query: (queryType: string) => Promise<unknown>;
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
  stateRefs: { readonly lastTurnId?: string; readonly turnsProcessed: number } | undefined,
  canCount: number,
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
    pendingSignals: desc.pendingNexusOperations?.length ?? 0,
    canCount,
    ...(entityType !== undefined ? { entityType } : {}),
    ...(stateRefs !== undefined ? { stateRefs } : {}),
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

      // Best-effort query for state refs and CAN count — non-fatal if unavailable
      let stateRefs: { readonly lastTurnId?: string; readonly turnsProcessed: number } | undefined;
      let canCount = 0;

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

      try {
        const rawCan = await handle.query("getCanCount");
        if (typeof rawCan === "number") {
          canCount = rawCan;
        }
      } catch {
        // Query not available
      }

      return { ok: true, value: mapDescriptionToDetail(desc, stateRefs, canCount) };
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
