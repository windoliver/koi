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

    // 1. Stop accepting new work
    callbacks.onStopAccepting();

    // 2. Drain active work with timeout
    const drainPromise = callbacks.onDrainAgents();
    let drainTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      drainTimeoutId = setTimeout(resolve, timeoutMs);
    });

    await Promise.race([drainPromise, timeoutPromise]);
    // Clear timer to prevent it from delaying process exit
    if (drainTimeoutId !== undefined) clearTimeout(drainTimeoutId);

    // 3. Clean up resources
    await callbacks.onCleanup();

    emit("shutdown_complete", { signal });
  }

  return {
    install() {
      const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
      for (const sig of signals) {
        const handler = (): void => {
          void doShutdown(sig);
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
