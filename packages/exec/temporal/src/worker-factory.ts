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

export interface WorkerConfig {
  readonly taskQueue: string;
  readonly url?: string | undefined;
  readonly namespace?: string | undefined;
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
  /**
   * Optional explicit readiness promise. If provided, `createTemporalWorker` awaits it
   * (with a 10-second timeout) before returning the handle. Production factories should
   * resolve this after the first successful poll or connection establishment.
   */
  readonly readyPromise?: Promise<void> | undefined;
}

export interface WorkerHandle {
  readonly worker: WorkerLike;
  readonly connection: NativeConnectionLike;
  /**
   * Resolves when the worker run loop completes, rejects on unexpected crashes.
   * Populated once run() or dispose() is called (whichever comes first).
   */
  readonly runPromise: Promise<void>;
  /**
   * Start the worker run loop. Idempotent — calling multiple times returns the same promise.
   */
  readonly run: () => Promise<void>;
  /**
   * Gracefully shut down: signal stop, await drain, then close connection.
   */
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Default factory (dynamically imports @temporalio/worker)
// ---------------------------------------------------------------------------

async function defaultCreateWorker(params: WorkerCreateParams): Promise<WorkerAndConnection> {
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
    await connection.close();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createTemporalWorker(
  config: WorkerConfig,
  activities: Record<string, (...args: readonly unknown[]) => unknown>,
  workflowsPath: string,
  createWorkerFn: (
    params: WorkerCreateParams,
  ) => Promise<WorkerAndConnection> = defaultCreateWorker,
): Promise<WorkerHandle> {
  const { worker, connection, readyPromise } = await createWorkerFn({
    serverUrl: config.url ?? "localhost:7233",
    namespace: config.namespace ?? "default",
    taskQueue: config.taskQueue,
    maxCachedWorkflows: config.maxCachedWorkflows ?? 100,
    workflowsPath,
    activities,
  });

  // Deferred run: the actual worker.run() is lazy — started on first call to
  // handle.run(), handle.worker.run(), or handle.dispose(). runPromise is always
  // a defined Promise<void> on the handle; it resolves/rejects once the run loop settles.
  let runStarted = false;
  let runResolve!: () => void;
  let runReject!: (err: unknown) => void;
  const runPromise = new Promise<void>((res, rej) => {
    runResolve = res;
    runReject = rej;
  });

  function startRun(): Promise<void> {
    if (!runStarted) {
      runStarted = true;
      worker.run().then(runResolve, runReject);
    }
    return runPromise;
  }

  // If the factory provides an explicit readiness signal, await it with a timeout
  // so the caller only receives a handle once the worker is actually polling.
  if (readyPromise !== undefined) {
    const STARTUP_TIMEOUT_MS = 10_000;
    let startupError: unknown;
    await Promise.race([
      readyPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("[temporal-worker] worker readiness timed out after 10s")),
          STARTUP_TIMEOUT_MS,
        ),
      ),
      startRun().then(() => {
        throw new Error("[temporal-worker] run loop exited unexpectedly during startup");
      }),
    ]).catch((err: unknown) => {
      startupError = err;
    });
    if (startupError !== undefined) {
      worker.shutdown();
      await connection.close().catch(() => {});
      throw new Error("[temporal-worker] worker failed during startup", { cause: startupError });
    }
  }

  const wrappedWorker: WorkerLike = {
    run: startRun,
    shutdown(): void {
      worker.shutdown();
    },
  };

  return {
    worker: wrappedWorker,
    connection,
    runPromise,

    run(): Promise<void> {
      return startRun();
    },

    async dispose(): Promise<void> {
      // Ensure the run loop is started so shutdown() can transition the worker
      // to STOPPED and release the NativeConnection reference.
      startRun();
      wrappedWorker.shutdown();
      await runPromise.catch(() => {
        // Swallow — shutting down intentionally; errors surfaced via runPromise.
      });
      await connection.close();
    },
  };
}
