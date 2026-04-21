/** Middleware name for the debug interceptor. */
export const DEBUG_MIDDLEWARE_NAME = "koi:debug";

/** Middleware priority — strictly outermost intercept layer, below all guard middleware. */
export const DEBUG_MIDDLEWARE_PRIORITY = -1000;

/** Default ring buffer size for event history. */
export const DEFAULT_EVENT_BUFFER_SIZE = 1_000;
