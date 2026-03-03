/**
 * Configuration types and tool descriptors for @koi/handoff.
 */

import type { AgentId, AgentRegistry, HandoffEvent, ToolDescriptor } from "@koi/core";
import type { HandoffStore } from "./store.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for the handoff provider and its tools/middleware. */
export interface HandoffConfig {
  readonly store: HandoffStore;
  /** Current agent's ID (used for target matching on accept). */
  readonly agentId: AgentId;
  /** Optional registry for cleanup on agent termination. */
  readonly registry?: AgentRegistry | undefined;
  /** Optional event listener for handoff lifecycle events. */
  readonly onEvent?: ((event: HandoffEvent) => void) | undefined;
}

/** Configuration for the handoff middleware. */
export interface HandoffMiddlewareConfig {
  readonly store: HandoffStore;
  /** Current agent's ID (used to find pending envelopes). */
  readonly agentId: AgentId;
  /** Optional event listener for injection events. */
  readonly onEvent?: ((event: HandoffEvent) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Tool descriptors
// ---------------------------------------------------------------------------

export const PREPARE_HANDOFF_DESCRIPTOR: ToolDescriptor = {
  name: "prepare_handoff",
  description:
    "Package current work into a typed envelope for the next agent in a pipeline. " +
    "Returns the envelope ID for the target agent to accept.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Target agent ID (provide exactly one of 'to' or 'capability')",
      },
      capability: {
        type: "string",
        description:
          "Resolve target by capability — hand off to the first running agent that declares " +
          "this capability (provide exactly one of 'to' or 'capability')",
      },
      completed: { type: "string", description: "Summary of what was accomplished" },
      next: { type: "string", description: "Instructions for the next agent" },
      results: { type: "object", description: "Structured results (JSON object)" },
      artifacts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            kind: { type: "string" },
            uri: { type: "string" },
            mimeType: { type: "string" },
            metadata: { type: "object" },
          },
          required: ["id", "kind", "uri"],
        },
        description: "Artifact references (URI-based)",
      },
      decisions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            action: { type: "string" },
            reasoning: { type: "string" },
            timestamp: { type: "number" },
            toolCallId: { type: "string" },
          },
          required: ["agentId", "action", "reasoning", "timestamp"],
        },
        description: "Decision records with agent reasoning",
      },
      warnings: {
        type: "array",
        items: { type: "string" },
        description: "Pitfalls or caveats for the next agent",
      },
      delegation: { type: "object", description: "Optional delegation grant to forward" },
      metadata: { type: "object", description: "Arbitrary metadata" },
    },
    required: ["completed", "next"],
  },
};

export const ACCEPT_HANDOFF_DESCRIPTOR: ToolDescriptor = {
  name: "accept_handoff",
  description:
    "Accept and unpack a handoff envelope. Returns full context including results, " +
    "artifacts, decisions, and any warnings.",
  inputSchema: {
    type: "object",
    properties: {
      handoff_id: { type: "string", description: "The handoff envelope ID to accept" },
    },
    required: ["handoff_id"],
  },
};
