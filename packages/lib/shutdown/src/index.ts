/**
 * @koi/shutdown — Generic graceful shutdown handler + exit codes.
 *
 * Extracted from @koi/node for reuse by @koi/deploy and CLI commands.
 * Zero dependencies — no @koi/core import needed.
 */

export {
  EXIT_CODES,
  EXIT_CONFIG,
  EXIT_CRITICAL,
  EXIT_ERROR,
  EXIT_NETWORK,
  EXIT_OK,
  EXIT_TIMEOUT,
  EXIT_UNAVAILABLE,
  EXIT_WARN,
  exitCodeForError,
} from "./exit-codes.js";
export type { ShutdownCallbacks, ShutdownEmit, ShutdownHandler } from "./shutdown.js";
export { createShutdownHandler } from "./shutdown.js";
