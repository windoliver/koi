/**
 * Constants for @koi/debug.
 */

/** Middleware name for the debug interceptor. */
export const DEBUG_MIDDLEWARE_NAME = "koi:debug";

/** Middleware priority — outer onion layer to wrap everything. */
export const DEBUG_MIDDLEWARE_PRIORITY = 50;

/** Default ring buffer size for event history. */
export const DEFAULT_EVENT_BUFFER_SIZE = 1_000;
