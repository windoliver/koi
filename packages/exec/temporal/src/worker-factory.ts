/**
 * Temporal Worker factory — creates and configures the embedded Worker.
 *
 * Decision 1B: Embedded in same Bun process (experimental).
 * The Worker runs in-process, sharing the event loop with the Bun host.
 */

import type { ActivityDeps } from "./activities/agent-activity.js";
import type { EngineCache } from "./engine-cache.js";
import type { TemporalHealthMonitor } from "./temporal-health.js";
import type { TemporalConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structural type for Temporal NativeConnection.
 * Avoids importing @temporalio/worker directly in this module's types.
 */
export interface NativeConnectionLike {
  readonly close: () => Promise<void>;
}

/**
 * Structural type for Temporal Worker.
 * The real Worker has many more methods; we only need run + shutdown.
 */
export interface WorkerLike {
  readonly run: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

/** Options for creating the Temporal Worker. */
export interface WorkerFactoryOptions {
  readonly config: TemporalConfig;
  readonly engineCache: EngineCache;
  readonly healthMonitor: TemporalHealthMonitor;
  readonly activityDeps: ActivityDeps;
}

/** Result of creating a Temporal Worker. */
export interface WorkerHandle {
  /** The running Worker instance. */
  readonly worker: WorkerLike;
  /** The gRPC connection (for client reuse). */
  readonly connection: NativeConnectionLike;
  /** Gracefully shut down the Worker and connection. */
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and configure a Temporal Worker for agent workflows.
 *
 * This function:
 * 1. Connects to the Temporal server (embedded or external)
 * 2. Registers workflow and activity definitions
 * 3. Returns a handle for lifecycle management
 *
 * The Worker is NOT started automatically — call `handle.worker.run()`.
 *
 * @param options - Worker factory options
 * @param createWorkerFn - Injectable Worker factory for testing.
 *   In production, this imports from @temporalio/worker.
 */
export async function createTemporalWorker(
  options: WorkerFactoryOptions,
  createWorkerFn?: (params: WorkerCreateParams) => Promise<WorkerAndConnection>,
): Promise<WorkerHandle> {
  const factory = createWorkerFn ?? defaultCreateWorker;

  const { worker, connection } = await factory({
    serverUrl: options.config.url ?? "localhost:7233",
    taskQueue: options.config.taskQueue,
    maxCachedWorkflows: options.config.maxCachedWorkflows,
    activityDeps: options.activityDeps,
  });

  return {
    worker,
    connection,
    async dispose() {
      await worker.shutdown();
      await connection.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Default Worker creation (uses actual Temporal SDK)
// ---------------------------------------------------------------------------

export interface WorkerCreateParams {
  readonly serverUrl: string;
  readonly taskQueue: string;
  readonly maxCachedWorkflows: number;
  readonly activityDeps: ActivityDeps;
}

export interface WorkerAndConnection {
  readonly worker: WorkerLike;
  readonly connection: NativeConnectionLike;
}

/**
 * Default Worker factory that uses the Temporal SDK.
 *
 * This is separated so it can be lazy-imported — the @temporalio/worker
 * package has heavy native dependencies (core-bridge NAPI).
 */
async function defaultCreateWorker(params: WorkerCreateParams): Promise<WorkerAndConnection> {
  // Dynamic import to defer loading of native module
  const { NativeConnection, Worker } = await import("@temporalio/worker");
  const { createActivities } = await import("./activities/agent-activity.js");

  const connection = await NativeConnection.connect({
    address: params.serverUrl,
  });

  const activities = createActivities(params.activityDeps);

  const worker = await Worker.create({
    connection,
    taskQueue: params.taskQueue,
    workflowsPath: new URL("./workflows/agent-workflow.js", import.meta.url).pathname,
    activities,
    maxCachedWorkflows: params.maxCachedWorkflows,
  });

  return { worker, connection };
}
