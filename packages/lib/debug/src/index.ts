// Public API

export type { MatchContext } from "./breakpoint-matcher.js";
// Breakpoint matching (useful for custom predicate evaluation)
export { matchesBreakpoint } from "./breakpoint-matcher.js";
// Constants
export {
  DEBUG_MIDDLEWARE_NAME,
  DEBUG_MIDDLEWARE_PRIORITY,
  DEFAULT_EVENT_BUFFER_SIZE,
} from "./constants.js";
export type { DebugAttachConfig, DebugAttachResult } from "./create-debug-attach.js";
export {
  clearAllDebugSessions,
  createDebugAttach,
  hasDebugSession,
} from "./create-debug-attach.js";
export type { EventRingBuffer } from "./event-ring-buffer.js";
// Ring buffer (useful for custom event consumers)
export { createEventRingBuffer } from "./event-ring-buffer.js";
