/**
 * Types for the delegation-escalation middleware.
 *
 * Defines the escalation context, decision union, configuration,
 * and the handle returned by the factory.
 */

import type { AgentId, ChannelAdapter, DelegationEvent, KoiMiddleware } from "@koi/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout waiting for human response (10 minutes). */
export const DEFAULT_ESCALATION_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Escalation Context
// ---------------------------------------------------------------------------

/** Context describing the exhaustion condition passed to message formatters. */
export interface EscalationContext {
  readonly issuerId: AgentId;
  readonly exhaustedDelegateeIds: readonly AgentId[];
  readonly detectedAt: number;
  readonly taskSummary?: string | undefined;
}

// ---------------------------------------------------------------------------
// Escalation Decision
// ---------------------------------------------------------------------------

/** Human's response to an escalation: resume with optional instruction or abort. */
export type EscalationDecision =
  | { readonly kind: "resume"; readonly instruction?: string | undefined }
  | { readonly kind: "abort"; readonly reason: string };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the delegation-escalation middleware. */
export interface DelegationEscalationConfig {
  /** Bidirectional channel for human communication. */
  readonly channel: ChannelAdapter;
  /**
   * Callback that returns true when all monitored delegatees are exhausted.
   * Consumer wires this to `manager.isExhausted(ids)`.
   */
  readonly isExhausted: () => boolean;
  /** The owning agent's ID. */
  readonly issuerId: AgentId;
  /** Delegatee IDs to include in the exhaustion event payload. */
  readonly monitoredDelegateeIds: readonly AgentId[];
  /** Optional task summary for the escalation message. */
  readonly taskSummary?: string | undefined;
  /** Timeout in ms waiting for human response (default: 600_000). */
  readonly escalationTimeoutMs?: number | undefined;
  /** Observability callback invoked when a human decision is received. */
  readonly onEscalation?: ((decision: EscalationDecision) => void) | undefined;
  /** Callback to emit the delegation:exhausted event to the event bus. */
  readonly onExhausted?: ((event: DelegationEvent) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

/** Handle returned by createDelegationEscalationMiddleware(). */
export interface DelegationEscalationHandle {
  /** The KoiMiddleware instance to register in the middleware chain. */
  readonly middleware: KoiMiddleware;
  /** Returns true if an escalation is currently awaiting human response. */
  readonly isPending: () => boolean;
  /** Cancels any pending escalation gate (resolves as abort). */
  readonly cancel: () => void;
}
