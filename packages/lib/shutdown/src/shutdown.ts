/**
 * Graceful shutdown handler — coordinates orderly process termination.
 *
 * Listens for SIGTERM, SIGINT, SIGHUP. Prevents duplicate triggers.
 * Sequence: stop accepting → drain work → cleanup → exit.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback to emit shutdown lifecycle events. */
export type ShutdownEmit = (type: string, data?: unknown) => void;

export interface ShutdownHandler {
  /** Register the shutdown handler on process signals. */
  readonly install: () => void;
  /** Trigger shutdown programmatically. */
  readonly shutdown: () => Promise<void>;
  /** Whether shutdown is in progress. */
  readonly isShuttingDown: () => boolean;
  /** Remove signal handlers (for testing). */
  readonly uninstall: () => void;
}

export interface ShutdownCallbacks {
  /** Called first — stop accepting new work. */
  readonly onStopAccepting: () => void;
  /** Called to wait for active work to complete. */
  readonly onDrainAgents: () => Promise<void>;
  /** Called to disconnect and clean up resources. */
  readonly onCleanup: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createShutdownHandler(
  callbacks: ShutdownCallbacks,
  emit: ShutdownEmit,
  timeoutMs: number = 30_000,
): ShutdownHandler {
  let shuttingDown = false;
  const signalHandlers = new Map<string, () => void>();

  async function doShutdown(signal?: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    emit("shutdown_started", { signal });

    // 1. Stop accepting new work — guarded so drain/cleanup always run
    try {
      callbacks.onStopAccepting();
    } catch (stopError: unknown) {
      emit("shutdown_error", {
        phase: "stopAccepting",
        error: stopError instanceof Error ? stopError.message : String(stopError),
      });
    }

    // 2. Drain active work with timeout — wrapped in try/finally so
    //    cleanup and shutdown_complete are always reached, even if
    //    onDrainAgents() rejects.
    let drainTimeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const drainPromise = callbacks.onDrainAgents();
      const timeoutPromise = new Promise<void>((resolve) => {
        drainTimeoutId = setTimeout(resolve, timeoutMs);
      });

      await Promise.race([drainPromise, timeoutPromise]);
    } catch (drainError: unknown) {
      emit("shutdown_error", {
        phase: "drain",
        error: drainError instanceof Error ? drainError.message : String(drainError),
      });
    } finally {
      if (drainTimeoutId !== undefined) clearTimeout(drainTimeoutId);
    }

    // 3. Clean up resources — also guarded so shutdown_complete fires
    try {
      await callbacks.onCleanup();
    } catch (cleanupError: unknown) {
      emit("shutdown_error", {
        phase: "cleanup",
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }

    emit("shutdown_complete", { signal });
  }

  return {
    install() {
      // Idempotency guard: repeated install() would leak duplicate listeners
      if (signalHandlers.size > 0) return;

      const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
      for (const sig of signals) {
        const handler = (): void => {
          // .catch prevents unhandled rejection when doShutdown rejects
          // (doShutdown is now resilient via try/finally, but defense-in-depth)
          void doShutdown(sig).catch((err: unknown) => {
            emit("shutdown_error", {
              phase: "signal",
              error: err instanceof Error ? err.message : String(err),
            });
          });
        };
        signalHandlers.set(sig, handler);
        process.on(sig, handler);
      }
    },

    async shutdown() {
      await doShutdown("programmatic");
    },

    isShuttingDown() {
      return shuttingDown;
    },

    uninstall() {
      for (const [sig, handler] of signalHandlers) {
        process.removeListener(sig, handler);
      }
      signalHandlers.clear();
    },
  };
}
