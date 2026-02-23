/**
 * Re-export from @koi/shutdown for backwards compatibility.
 *
 * @koi/node consumers that imported from "./shutdown.js" continue to work.
 * New code should import from @koi/shutdown directly.
 */

export type { ShutdownCallbacks, ShutdownEmit, ShutdownHandler } from "@koi/shutdown";
export { createShutdownHandler } from "@koi/shutdown";
