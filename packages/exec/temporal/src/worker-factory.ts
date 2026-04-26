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

import type { TemporalConfig } from "./types.js";

export interface WorkerFactoryOptions {
  readonly config: TemporalConfig;
}

export interface WorkerCreateParams {
  readonly serverUrl: string;
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
   * (with a 10-second timeout) before returning the handle, so callers only receive a
   * handle once the worker has actually connected and entered its polling loop.
   *
   * Production factories should resolve this after the first successful task-queue poll
   * or connection establishment. If absent, a one-macrotask heuristic is used instead,
   * which only catches synchronous startup failures.
   */
  readonly readyPromise?: Promise<void> | undefined;
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

/**
 * Creates a Temporal Worker bound to the given config.
 *
 * Temporal is optional infrastructure — callers must inject `createWorkerFn`
 * to avoid a hard dependency on @temporalio/worker (which has native bindings).
 * In production, pass a factory that wraps NativeConnection + Worker.create.
 * In tests, inject a mock factory.
 */
export async function createTemporalWorker(
  options: WorkerFactoryOptions,
  workflowsPath: string,
  activities: Record<string, (...args: readonly unknown[]) => unknown>,
  createWorkerFn: (
    params: WorkerCreateParams,
  ) => Promise<WorkerAndConnection> = defaultCreateWorker,
): Promise<WorkerHandle> {
  const { worker, connection, readyPromise } = await createWorkerFn({
    serverUrl: options.config.url ?? "localhost:7233",
    taskQueue: options.config.taskQueue,
    maxCachedWorkflows: options.config.maxCachedWorkflows ?? 100,
    workflowsPath,
    activities,
  });

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

  // Startup readiness check: prefer an explicit readyPromise from the factory (which can
  // resolve after the first successful poll or connection establishment) over the heuristic
  // setTimeout(0) that only catches synchronous failures. Both paths clean up on failure.
  let startupError: unknown;
  if (readyPromise !== undefined) {
    const STARTUP_TIMEOUT_MS = 10_000;
    const earlyRun = wrappedWorker.run();
    await Promise.race([
      readyPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("[temporal-worker] worker readiness timed out after 10s")),
          STARTUP_TIMEOUT_MS,
        ),
      ),
      earlyRun.then(() => {
        throw new Error("[temporal-worker] run loop exited unexpectedly during startup");
      }),
    ]).catch((err: unknown) => {
      startupError = err;
    });
  } else {
    // Heuristic fallback: one macrotask to catch synchronous / near-synchronous startup errors
    // (bad native bindings, missing config). This does not catch async connection failures.
    const earlyRun = wrappedWorker.run();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 0);
      earlyRun.catch((err: unknown) => {
        startupError = err;
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (startupError !== undefined) {
    // Release native resources before throwing — without cleanup, repeated failed startups
    // (bad config, outage) accumulate leaked connections and exhaust file descriptors.
    worker.shutdown();
    await connection.close().catch(() => {});
    throw new Error("[temporal-worker] worker failed during startup", { cause: startupError });
  }

  return {
    worker: wrappedWorker,
    connection,

    run(): Promise<void> {
      return wrappedWorker.run();
    },

    async dispose(): Promise<void> {
      if (runPromise === undefined) {
        // Worker holds a ref-count on the connection. Start it so shutdown()
        // can transition it to STOPPED and release the reference.
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
