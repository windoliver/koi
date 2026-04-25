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
  /**
   * Start the worker and track its run promise so dispose() can drain before
   * closing the connection. Equivalent to worker.run() but drain-aware.
   */
  readonly run: () => Promise<void>;
  /**
   * Gracefully shut down: signal stop, wait for drain, then close connection.
   * Safe to call before or after run() — if run() was never called, shutdown
   * is signalled and connection closed immediately.
   */
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Default factory (dynamically imports @temporalio/worker)
// ---------------------------------------------------------------------------

async function defaultCreateWorker(params: WorkerCreateParams): Promise<WorkerAndConnection> {
  // Dynamic import keeps @temporalio/worker out of the module graph for test environments
  const { Worker, NativeConnection } = await import("@temporalio/worker");

  const connection = await NativeConnection.connect({ address: params.serverUrl });
  try {
    const worker = await Worker.create({
      connection,
      namespace: params.namespace,
      taskQueue: params.taskQueue,
      maxCachedWorkflows: params.maxCachedWorkflows,
      workflowsPath: params.workflowsPath,
      activities: params.activities,
    });
    return { worker, connection };
  } catch (e: unknown) {
    // Close the gRPC connection to avoid leaking it on worker creation failure.
    await connection.close();
    throw e;
  }
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

  // Tracks the promise returned by worker.run() so dispose() can drain.
  // wrappedWorker intercepts run() so any call path — handle.run() or
  // handle.worker.run() — always records runPromise.
  let runPromise: Promise<void> | undefined;

  const wrappedWorker: WorkerLike = {
    run(): Promise<void> {
      if (runPromise === undefined) {
        runPromise = worker.run();
      }
      return runPromise;
    },
    shutdown(): void {
      worker.shutdown();
    },
  };

  return {
    worker: wrappedWorker,
    connection,

    run(): Promise<void> {
      return wrappedWorker.run();
    },

    async dispose(): Promise<void> {
      if (runPromise === undefined) {
        // Worker is INITIALIZED and holds a ref-count on the connection.
        // NativeConnection.close() throws "Cannot close connection while Workers
        // hold a reference" until the worker reaches STOPPED state. Start it
        // now so shutdown() can transition it out of INITIALIZED and release
        // the reference before we close the transport.
        runPromise = worker.run();
      }
      wrappedWorker.shutdown();
      await runPromise.catch(() => {
        // Swallow — shutting down intentionally; errors surfaced to run() caller.
      });
      await connection.close();
    },
  };
}
