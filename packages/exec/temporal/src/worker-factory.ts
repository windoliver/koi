/**
 * Temporal Worker factory — creates and wires the in-process Worker.
 *
 * The actual @temporalio/worker import is deferred behind a createWorkerFn
 * parameter so this module stays testable without the SDK installed in tests.
 */

// ---------------------------------------------------------------------------
// Structural types (no @temporalio/* imports)
// ---------------------------------------------------------------------------

export interface NativeConnectionLike {
  readonly close: () => Promise<void>;
}

export interface WorkerLike {
  readonly run: () => Promise<void>;
  readonly shutdown: () => void;
}

export interface TemporalConfig {
  readonly url?: string | undefined;
  readonly namespace?: string | undefined;
  readonly taskQueue: string;
  readonly maxCachedWorkflows?: number | undefined;
}

export interface WorkerCreateParams {
  readonly serverUrl: string;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly maxCachedWorkflows: number;
  readonly workflowsPath: string;
  readonly activities: Record<string, (...args: readonly unknown[]) => unknown>;
}

export interface WorkerAndConnection {
  readonly worker: WorkerLike;
  readonly connection: NativeConnectionLike;
}

export interface WorkerHandle {
  readonly worker: WorkerLike;
  readonly connection: NativeConnectionLike;
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Default factory (dynamically imports @temporalio/worker)
// ---------------------------------------------------------------------------

async function defaultCreateWorker(params: WorkerCreateParams): Promise<WorkerAndConnection> {
  // Dynamic import keeps @temporalio/worker out of the module graph for test environments
  const { Worker, NativeConnection } = await import("@temporalio/worker");

  const connection = await NativeConnection.connect({ address: params.serverUrl });
  const worker = await Worker.create({
    connection,
    namespace: params.namespace,
    taskQueue: params.taskQueue,
    maxCachedWorkflows: params.maxCachedWorkflows,
    workflowsPath: params.workflowsPath,
    activities: params.activities,
  });

  return { worker, connection };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createTemporalWorker(
  config: TemporalConfig,
  activities: Record<string, (...args: readonly unknown[]) => unknown>,
  workflowsPath: string,
  createWorkerFn: (
    params: WorkerCreateParams,
  ) => Promise<WorkerAndConnection> = defaultCreateWorker,
): Promise<WorkerHandle> {
  const { worker, connection } = await createWorkerFn({
    serverUrl: config.url ?? "localhost:7233",
    namespace: config.namespace ?? "default",
    taskQueue: config.taskQueue,
    maxCachedWorkflows: config.maxCachedWorkflows ?? 100,
    workflowsPath,
    activities,
  });

  return {
    worker,
    connection,
    async dispose(): Promise<void> {
      worker.shutdown();
      await connection.close();
    },
  };
}
