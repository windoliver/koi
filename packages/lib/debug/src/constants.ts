/** Middleware name for the debug interceptor. */
export const DEBUG_MIDDLEWARE_NAME = "koi:debug";

/** Middleware priority — strictly outermost intercept layer, below all guard middleware. */
export const DEBUG_MIDDLEWARE_PRIORITY = -1000;

/** Default ring buffer size for event history. */
export const DEFAULT_EVENT_BUFFER_SIZE = 1_000;

/**
 * Maximum payload size (bytes) retained per debug event.
 * Larger values are replaced with a truncation placeholder. Prevents a single
 * debug session from pinning megabytes of tool/model output per event.
 */
export const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024; // 16 KiB

/**
 * Engine event kinds that this debug middleware observes and can break on.
 *
 * Note: the public `BreakpointPredicate` contract in `@koi/core` is broader
 * than this runtime supports. In particular, `{ kind: "error" }` predicates
 * and `event_kind` predicates for engine-emitted events like `"done"` are
 * rejected at `breakOn()` time because this middleware only wraps
 * model/tool calls and never observes terminal engine events. Callers that
 * need failure-path breakpoints must subscribe to engine events directly.
 */
export const SUPPORTED_EVENT_KINDS = [
  "turn_start",
  "turn_end",
  "tool_call_start",
  "tool_call_end",
  "tool_result",
  "text_delta",
  "custom",
] as const;

export type SupportedBreakpointEventKind = (typeof SUPPORTED_EVENT_KINDS)[number];
