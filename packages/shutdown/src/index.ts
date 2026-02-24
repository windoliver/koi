/**
 * @koi/shutdown — Generic graceful shutdown handler + exit codes.
 *
 * Extracted from @koi/node for reuse by @koi/deploy and CLI commands.
 * Zero dependencies — no @koi/core import needed.
 */

export {
  EXIT_CONFIG,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  exitCodeForError,
} from "./exit-codes.js";
export type { ShutdownCallbacks, ShutdownEmit, ShutdownHandler } from "./shutdown.js";
export { createShutdownHandler } from "./shutdown.js";
