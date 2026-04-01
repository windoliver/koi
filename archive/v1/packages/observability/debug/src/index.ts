/**
 * @koi/debug — Runtime debugging with breakpoints, step/pause, inspection.
 *
 * L2 package. Depends on @koi/core (L0) only.
 */

// Re-export L0 types for convenience
export type {
  Breakpoint,
  BreakpointId,
  BreakpointOptions,
  BreakpointPredicate,
  ComponentMetadata,
  ComponentSnapshot,
  DebugEvent,
  DebugObserver,
  DebugSession,
  DebugSessionId,
  DebugSnapshot,
  DebugState,
  InspectComponentOptions,
  StepOptions,
} from "@koi/core";
export type { MatchContext } from "./breakpoint-matcher.js";
export { matchesBreakpoint } from "./breakpoint-matcher.js";
// Package exports
export type { DebugAttachConfig, DebugAttachResult } from "./create-debug-attach.js";
export {
  clearAllDebugSessions,
  createDebugAttach,
  createDebugObserve,
  hasDebugSession,
} from "./create-debug-attach.js";
export type { EventRingBuffer } from "./event-ring-buffer.js";
export { createEventRingBuffer } from "./event-ring-buffer.js";
