/**
 * Handoff types — structured context relay for agent-to-agent baton passing.
 *
 * All types are immutable (readonly). No runtime code except the branded
 * type constructor for HandoffId.
 */

import type { JsonObject } from "./common.js";
import type { DelegationGrant } from "./delegation.js";
import type { AgentId, ToolCallId } from "./ecs.js";

// ---------------------------------------------------------------------------
// Branded handoff ID
// ---------------------------------------------------------------------------

declare const __handoffBrand: unique symbol;

/**
 * Branded string type for handoff envelope identifiers.
 * Prevents accidental mixing with other string IDs at compile time.
 */
export type HandoffId = string & { readonly [__handoffBrand]: "HandoffId" };

/** Create a branded HandoffId from a plain string. */
export function handoffId(raw: string): HandoffId {
  return raw as HandoffId;
}

// ---------------------------------------------------------------------------
// Decision record — agent reasoning trace
// ---------------------------------------------------------------------------

/** A single decision record capturing agent reasoning during a phase. */
export interface DecisionRecord {
  readonly agentId: AgentId;
  readonly action: string;
  readonly reasoning: string;
  readonly timestamp: number;
  readonly toolCallId?: ToolCallId | undefined;
}

// ---------------------------------------------------------------------------
// Artifact reference — URI-based, storage-agnostic
// ---------------------------------------------------------------------------

/** URI-based reference to an artifact produced during a phase. */
export interface ArtifactRef {
  readonly id: string;
  /** Artifact kind: "file" | "data" | "analysis" | custom. */
  readonly kind: string;
  /** URI pointing to the artifact (e.g., "file:///workspace/output.json"). */
  readonly uri: string;
  readonly mimeType?: string | undefined;
  readonly metadata?: JsonObject | undefined;
}

// ---------------------------------------------------------------------------
// Handoff envelope status
// ---------------------------------------------------------------------------

/** Lifecycle status of a handoff envelope. */
export type HandoffStatus = "pending" | "injected" | "accepted" | "expired";

// ---------------------------------------------------------------------------
// Handoff envelope
// ---------------------------------------------------------------------------

/** Typed envelope for agent-to-agent context relay. */
export interface HandoffEnvelope {
  readonly id: HandoffId;
  readonly from: AgentId;
  readonly to: AgentId;
  readonly status: HandoffStatus;
  readonly createdAt: number;
  readonly phase: {
    readonly completed: string;
    readonly next: string;
  };
  readonly context: {
    readonly results: JsonObject;
    readonly artifacts: readonly ArtifactRef[];
    readonly decisions: readonly DecisionRecord[];
    readonly warnings: readonly string[];
  };
  readonly delegation?: DelegationGrant | undefined;
  readonly metadata: JsonObject;
}

// ---------------------------------------------------------------------------
// Handoff events (discriminated union)
// ---------------------------------------------------------------------------

/** Events emitted during handoff lifecycle operations. */
export type HandoffEvent =
  | { readonly kind: "handoff:prepared"; readonly envelope: HandoffEnvelope }
  | { readonly kind: "handoff:injected"; readonly handoffId: HandoffId }
  | {
      readonly kind: "handoff:accepted";
      readonly handoffId: HandoffId;
      readonly warnings: readonly string[];
    }
  | { readonly kind: "handoff:expired"; readonly handoffId: HandoffId };

// ---------------------------------------------------------------------------
// Handoff accept result
// ---------------------------------------------------------------------------

/** Error codes for handoff acceptance failures. */
export type HandoffAcceptError =
  | { readonly code: "NOT_FOUND"; readonly handoffId: string }
  | { readonly code: "ALREADY_ACCEPTED"; readonly handoffId: string }
  | { readonly code: "TARGET_MISMATCH"; readonly expected: string; readonly actual: string }
  | { readonly code: "EXPIRED"; readonly handoffId: string };

/** Result of accepting a handoff envelope. */
export type HandoffAcceptResult =
  | {
      readonly ok: true;
      readonly envelope: HandoffEnvelope;
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly error: HandoffAcceptError };

// ---------------------------------------------------------------------------
// Handoff component (ECS singleton)
// ---------------------------------------------------------------------------

/** ECS component interface for handoff operations on an agent. */
export interface HandoffComponent {
  readonly prepare: (
    envelope: Omit<HandoffEnvelope, "id" | "status" | "createdAt">,
  ) => Promise<HandoffEnvelope>;
  readonly accept: (handoffId: HandoffId) => Promise<HandoffAcceptResult>;
  readonly get: (handoffId: HandoffId) => HandoffEnvelope | undefined;
  readonly list: () => readonly HandoffEnvelope[];
}
