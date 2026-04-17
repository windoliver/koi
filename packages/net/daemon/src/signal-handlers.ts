import type { Supervisor } from "@koi/core";

export interface SignalHandlerOptions {
  /**
   * How to terminate the process after shutdown completes. Default: re-raise
   * the received signal with default handlers so the process exits with
   * normal signal semantics (exit code 128 + signal number). Set to "noop"
   * for test environments that want to inspect shutdown result without
   * exiting the process.
   */
  readonly onShutdownComplete?: "reraise" | "noop";
  /**
   * Called with the shutdown result on completion. Default logs to stderr
   * on failure. Callers can hook telemetry here.
   */
  readonly onShutdownResult?: (
    sig: NodeJS.Signals,
    result: Awaited<ReturnType<Supervisor["shutdown"]>>,
  ) => void;
}

/**
 * Register SIGTERM/SIGINT handlers that drive graceful shutdown.
 *
 * Semantics:
 *   - First signal: start shutdown. The handler awaits the result, reports
 *     failures, then (by default) re-raises the signal so the process exits
 *     with default signal semantics.
 *   - Second signal during shutdown: bypass graceful teardown and force
 *     exit immediately — operators that send a second SIGINT expect it to
 *     take effect without waiting for more draining.
 *   - The handler is one-shot per signal. If shutdown succeeds on the first
 *     signal, subsequent signals fall through to default behavior.
 *
 * Returns a cleanup function that removes the handlers (useful in tests).
 */
export function registerSignalHandlers(
  supervisor: Supervisor,
  options?: SignalHandlerOptions,
): () => void {
  const signals: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  const onComplete = options?.onShutdownComplete ?? "reraise";
  const onResult =
    options?.onShutdownResult ??
    ((sig, result): void => {
      if (!result.ok) {
        // eslint-disable-next-line no-console -- stderr is the right channel
        console.error(
          `[daemon] shutdown on ${sig} failed: ${result.error.code} ${result.error.message}`,
        );
      }
    });

  let shuttingDown = false;
  const handler = (sig: NodeJS.Signals): void => {
    if (shuttingDown) {
      // Second signal during shutdown — operator wants out NOW. Remove our
      // handlers so the next identical signal hits the default handler,
      // and exit with the conventional exit code for the signal.
      for (const s of signals) process.off(s, handler);
      const code = sig === "SIGTERM" ? 143 : sig === "SIGINT" ? 130 : 1;
      process.exit(code);
    }
    shuttingDown = true;

    void (async (): Promise<void> => {
      let result: Awaited<ReturnType<Supervisor["shutdown"]>>;
      try {
        result = await supervisor.shutdown(sig);
      } catch (e) {
        result = {
          ok: false,
          error: {
            code: "INTERNAL",
            message: `shutdown threw: ${e instanceof Error ? e.message : String(e)}`,
            retryable: false,
          },
        };
      }
      onResult(sig, result);
      if (onComplete === "noop") return;
      for (const s of signals) process.off(s, handler);
      if (result.ok) {
        // Clean shutdown — re-raise so default signal handler takes over
        // and exits with the canonical signal-termination exit code.
        process.kill(process.pid, sig);
        return;
      }
      // Shutdown FAILED — some workers may still be running. DO NOT
      // re-raise the signal (which would force-exit and orphan children).
      // Stay alive so an operator can inspect and recover. A second
      // signal will force-exit via the shuttingDown guard below.
    })();
  };
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}
