/**
 * Debug types — runtime debugging with breakpoints, step/pause, inspection.
 *
 * Provides the L0 contract for debug-attach:
 * - `DebugSession` — single-attach debug controller with step/pause/inspect
 * - `DebugObserver` — read-only observer (multiple allowed)
 * - `BreakpointPredicate` — structured-only breakpoint conditions
 *
 * Exception: branded type constructors (identity casts) are permitted in L0
 * as zero-logic operations for type safety.
 * Exception: pure readonly data constants codify architecture-doc invariants
 * with zero logic.
 */

import type { AgentId, SubsystemToken } from "./ecs.js";
import type { EngineEvent } from "./engine.js";
import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

declare const __debugSessionBrand: unique symbol;

/** Branded string type for debug session identifiers. */
export type DebugSessionId = string & { readonly [__debugSessionBrand]: "DebugSessionId" };

/** Create a branded DebugSessionId from a plain string. */
export function debugSessionId(raw: string): DebugSessionId {
  return raw as DebugSessionId;
}

declare const __breakpointBrand: unique symbol;

/** Branded string type for breakpoint identifiers. */
export type BreakpointId = string & { readonly [__breakpointBrand]: "BreakpointId" };

/** Create a branded BreakpointId from a plain string. */
export function breakpointId(raw: string): BreakpointId {
  return raw as BreakpointId;
}

// ---------------------------------------------------------------------------
// Breakpoint predicates (all serializable — no custom functions)
// ---------------------------------------------------------------------------

/**
 * Structured breakpoint predicate. Discriminated union of supported conditions.
 *
 * - `turn` — break on turn boundary (optionally at specific index or every N turns)
 * - `tool_call` — break on tool call (optionally matching specific tool name)
 * - `error` — break on any error event
 * - `event_kind` — break on a specific EngineEvent kind
 */
export type BreakpointPredicate =
  | {
      readonly kind: "turn";
      readonly turnIndex?: number | undefined;
      readonly every?: number | undefined;
    }
  | { readonly kind: "tool_call"; readonly toolName?: string | undefined }
  | { readonly kind: "error" }
  | { readonly kind: "event_kind"; readonly eventKind: EngineEvent["kind"] };

// ---------------------------------------------------------------------------
// Inspection types
// ---------------------------------------------------------------------------

/** Metadata about an agent component (lightweight — no actual data). */
export interface ComponentMetadata {
  readonly token: string;
  readonly typeHint: string;
  readonly approximateBytes: number;
  readonly serializable: boolean;
}

/** Full agent snapshot for debugging. */
export interface DebugSnapshot {
  readonly agentId: AgentId;
  readonly sessionId: string;
  readonly debugSessionId: DebugSessionId;
  readonly processState: string;
  readonly turnIndex: number;
  readonly components: readonly ComponentMetadata[];
  readonly breakpoints: readonly Breakpoint[];
  readonly eventBufferSize: number;
  readonly timestamp: string;
}

/** On-demand component data with pagination support. */
export interface ComponentSnapshot {
  readonly token: string;
  readonly data: unknown;
  readonly totalItems?: number | undefined;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

/** Options for paginated component inspection. */
export interface InspectComponentOptions {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

// ---------------------------------------------------------------------------
// Breakpoint
// ---------------------------------------------------------------------------

/** A registered breakpoint with its predicate and options. */
export interface Breakpoint {
  readonly id: BreakpointId;
  readonly predicate: BreakpointPredicate;
  readonly once: boolean;
  readonly label?: string | undefined;
}

/** Options for registering a breakpoint. */
export interface BreakpointOptions {
  readonly once?: boolean | undefined;
  readonly label?: string | undefined;
}

// ---------------------------------------------------------------------------
// Step options
// ---------------------------------------------------------------------------

/** Options for stepping through execution. */
export interface StepOptions {
  readonly count?: number | undefined;
  readonly until?: BreakpointPredicate | undefined;
}

// ---------------------------------------------------------------------------
// Debug state (discriminated union)
// ---------------------------------------------------------------------------

/** Current state of a debug session. */
export type DebugState =
  | { readonly kind: "detached" }
  | { readonly kind: "attached"; readonly since: string }
  | {
      readonly kind: "paused";
      readonly since: string;
      readonly breakpointId?: BreakpointId | undefined;
      readonly turnIndex: number;
      readonly event?: EngineEvent | undefined;
    };

// ---------------------------------------------------------------------------
// Debug events
// ---------------------------------------------------------------------------

/** Events emitted by a debug session. */
export type DebugEvent =
  | {
      readonly kind: "attached";
      readonly debugSessionId: DebugSessionId;
      readonly agentId: AgentId;
    }
  | {
      readonly kind: "detached";
      readonly debugSessionId: DebugSessionId;
      readonly reason: "user" | "agent_terminated" | "replaced";
    }
  | {
      readonly kind: "paused";
      readonly debugSessionId: DebugSessionId;
      readonly breakpointId?: BreakpointId | undefined;
      readonly turnIndex: number;
    }
  | { readonly kind: "resumed"; readonly debugSessionId: DebugSessionId }
  | {
      readonly kind: "breakpoint_hit";
      readonly debugSessionId: DebugSessionId;
      readonly breakpointId: BreakpointId;
      readonly turnIndex: number;
      readonly event?: EngineEvent | undefined;
    }
  | {
      readonly kind: "step_completed";
      readonly debugSessionId: DebugSessionId;
      readonly turnIndex: number;
    }
  | { readonly kind: "error"; readonly debugSessionId: DebugSessionId; readonly error: KoiError };

// ---------------------------------------------------------------------------
// Debug session (single-attach controller)
// ---------------------------------------------------------------------------

/**
 * Single-attach debug controller for an agent.
 *
 * - `detach` — detach from agent; auto-resumes if paused
 * - `step` — advance execution (only valid when paused)
 * - `resume` — resume execution (only valid when paused)
 * - `inspect` — get agent snapshot with component metadata
 * - `inspectComponent` — fetch on-demand component data with pagination
 * - `breakOn` — register a breakpoint
 * - `removeBreakpoint` — remove a registered breakpoint
 * - `onDebugEvent` — subscribe to debug events (returns unsubscribe fn)
 * - `state` — current debug state
 * - `events` — recent engine events from ring buffer
 * - `createObserver` — create a read-only observer
 */
export interface DebugSession {
  readonly id: DebugSessionId;
  readonly agentId: AgentId;
  readonly detach: () => void | Promise<void>;
  readonly step: (options?: StepOptions) => Result<void, KoiError>;
  readonly resume: () => Result<void, KoiError>;
  readonly inspect: (
    tokens?: readonly SubsystemToken<unknown>[],
  ) => DebugSnapshot | Promise<DebugSnapshot>;
  readonly inspectComponent: (
    token: SubsystemToken<unknown>,
    options?: InspectComponentOptions,
  ) => Result<ComponentSnapshot, KoiError> | Promise<Result<ComponentSnapshot, KoiError>>;
  readonly breakOn: (predicate: BreakpointPredicate, options?: BreakpointOptions) => Breakpoint;
  readonly removeBreakpoint: (id: BreakpointId) => boolean;
  readonly onDebugEvent: (listener: (event: DebugEvent) => void) => () => void;
  readonly state: () => DebugState;
  readonly events: (limit?: number) => readonly EngineEvent[];
  readonly createObserver: () => DebugObserver;
}

// ---------------------------------------------------------------------------
// Debug observer (read-only, multiple allowed)
// ---------------------------------------------------------------------------

/**
 * Read-only debug observer. Multiple observers can attach simultaneously.
 * Shares the debug session's event buffer.
 */
export interface DebugObserver {
  readonly id: string;
  readonly agentId: AgentId;
  readonly inspect: (
    tokens?: readonly SubsystemToken<unknown>[],
  ) => DebugSnapshot | Promise<DebugSnapshot>;
  readonly inspectComponent: (
    token: SubsystemToken<unknown>,
    options?: InspectComponentOptions,
  ) => Result<ComponentSnapshot, KoiError> | Promise<Result<ComponentSnapshot, KoiError>>;
  readonly events: (limit?: number) => readonly EngineEvent[];
  readonly onDebugEvent: (listener: (event: DebugEvent) => void) => () => void;
  readonly detach: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of events retained in the ring buffer. */
export const DEFAULT_DEBUG_BUFFER_SIZE = 1_000;

/** Default limit for paginated component inspection. */
export const DEFAULT_INSPECT_LIMIT = 100;
