/**
 * Transport connection state machine.
 *
 * Models the full lifecycle of an MCP transport connection as a
 * discriminated union with explicit valid transitions. Invalid
 * transitions throw at runtime and are caught at test time.
 */

import type { KoiError } from "@koi/core";

// ---------------------------------------------------------------------------
// Auth challenge (surfaced by transport on 401/403)
// ---------------------------------------------------------------------------

export interface AuthChallenge {
  readonly type: "bearer" | "oauth";
  readonly realm?: string | undefined;
  readonly scope?: string | undefined;
}

// ---------------------------------------------------------------------------
// Transport state — discriminated union
// ---------------------------------------------------------------------------

export type TransportState =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "connected"; readonly sessionId?: string | undefined }
  | {
      readonly kind: "reconnecting";
      readonly attempt: number;
      readonly lastError: KoiError;
    }
  | {
      readonly kind: "auth-needed";
      readonly challenge?: AuthChallenge | undefined;
    }
  | {
      readonly kind: "error";
      readonly error: KoiError;
      readonly retryable: boolean;
    }
  | { readonly kind: "closed" };

// ---------------------------------------------------------------------------
// Valid transitions table
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Readonly<
  Record<TransportState["kind"], readonly TransportState["kind"][]>
> = {
  idle: ["connecting", "closed"],
  connecting: ["connected", "error", "auth-needed", "closed"],
  connected: ["reconnecting", "error", "closed"],
  reconnecting: ["connected", "error", "auth-needed", "closed"],
  "auth-needed": ["connecting", "closed"],
  error: ["connecting", "reconnecting", "closed"],
  closed: [],
};

// ---------------------------------------------------------------------------
// State machine interface
// ---------------------------------------------------------------------------

export type TransportStateListener = (state: TransportState) => void;

export interface TransportStateMachine {
  /** Current state (readonly snapshot). */
  readonly current: TransportState;
  /** Transition to a new state. Throws if the transition is invalid. */
  readonly transition: (next: TransportState) => void;
  /** Subscribe to state changes. Returns unsubscribe function. */
  readonly onChange: (listener: TransportStateListener) => () => void;
  /** Check if a transition to the target kind is valid from the current state. */
  readonly canTransitionTo: (kind: TransportState["kind"]) => boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTransportStateMachine(): TransportStateMachine {
  // let justified: mutable state tracking for state machine
  let current: TransportState = { kind: "idle" };
  const listeners = new Set<TransportStateListener>();

  function transition(next: TransportState): void {
    const validTargets = VALID_TRANSITIONS[current.kind];
    if (!validTargets.includes(next.kind)) {
      throw new Error(`Invalid transport state transition: ${current.kind} -> ${next.kind}`);
    }
    current = next;
    for (const listener of listeners) {
      listener(current);
    }
  }

  function onChange(listener: TransportStateListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function canTransitionTo(kind: TransportState["kind"]): boolean {
    return VALID_TRANSITIONS[current.kind].includes(kind);
  }

  return {
    get current() {
      return current;
    },
    transition,
    onChange,
    canTransitionTo,
  };
}
