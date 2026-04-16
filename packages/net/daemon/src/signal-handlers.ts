import type { Supervisor } from "@koi/core";

/**
 * Register SIGTERM/SIGINT handlers that invoke `supervisor.shutdown`.
 * Returns a cleanup function that removes the handlers.
 *
 * The shutdown is fired asynchronously (void-awaited). The process is NOT
 * automatically exited — callers decide whether to call `process.exit` after
 * shutdown completes, log the result, etc. This keeps the helper composable
 * with test environments and with callers that want custom teardown.
 */
export function registerSignalHandlers(supervisor: Supervisor): () => void {
  const signals: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  const handler = (sig: NodeJS.Signals): void => {
    void supervisor.shutdown(sig);
  };
  for (const s of signals) process.on(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
}
