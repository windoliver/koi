/** Middleware name for the debug interceptor. */
export const DEBUG_MIDDLEWARE_NAME = "koi:debug";

/** Middleware priority — outer onion layer (wraps all other middleware). */
export const DEBUG_MIDDLEWARE_PRIORITY = 50;

/** Default ring buffer size for event history. */
export const DEFAULT_EVENT_BUFFER_SIZE = 1_000;
