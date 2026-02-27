/**
 * accept_handoff tool factory — creates a Tool that accepts and
 * unpacks a HandoffEnvelope, returning full context to the agent.
 */

import type {
  AgentId,
  HandoffAcceptResult,
  HandoffEvent,
  HandoffId,
  JsonObject,
  Tool,
} from "@koi/core";
import { handoffId } from "@koi/core";
import type { HandoffStore } from "./store.js";
import { ACCEPT_HANDOFF_DESCRIPTOR } from "./types.js";
import { validateAcceptInput, validateArtifactRefs } from "./validate.js";

export interface CreateAcceptToolConfig {
  readonly store: HandoffStore;
  readonly agentId: AgentId;
  readonly onEvent?: ((event: HandoffEvent) => void) | undefined;
}

export function createAcceptTool(config: CreateAcceptToolConfig): Tool {
  return {
    descriptor: ACCEPT_HANDOFF_DESCRIPTOR,
    trustTier: "verified",

    async execute(args: JsonObject): Promise<unknown> {
      const validation = validateAcceptInput(args);
      if (!validation.ok) {
        return makeError("VALIDATION", validation.message);
      }

      const id: HandoffId = handoffId(validation.handoffId);
      const result = accept(config, id);

      if (!result.ok) {
        const err = result.error;
        switch (err.code) {
          case "NOT_FOUND":
            return makeError("NOT_FOUND", `Handoff envelope not found: ${err.handoffId}`);
          case "ALREADY_ACCEPTED":
            return makeError("ALREADY_ACCEPTED", `Handoff already accepted: ${err.handoffId}`);
          case "TARGET_MISMATCH":
            return makeError(
              "TARGET_MISMATCH",
              `Target mismatch: expected ${err.expected}, got ${err.actual}`,
            );
          case "EXPIRED":
            return makeError("EXPIRED", `Handoff expired: ${err.handoffId}`);
        }
      }

      config.onEvent?.({
        kind: "handoff:accepted",
        handoffId: id,
        warnings: result.warnings,
      });

      return {
        handoffId: result.envelope.id,
        from: result.envelope.from,
        phase: result.envelope.phase,
        results: result.envelope.context.results,
        artifacts: result.envelope.context.artifacts,
        decisions: result.envelope.context.decisions,
        warnings: result.warnings,
        delegation: result.envelope.delegation,
        metadata: result.envelope.metadata,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Core accept logic (pure, testable)
// ---------------------------------------------------------------------------

function accept(config: CreateAcceptToolConfig, id: HandoffId): HandoffAcceptResult {
  const envelope = config.store.get(id);
  if (envelope === undefined) {
    return { ok: false, error: { code: "NOT_FOUND", handoffId: id } };
  }

  if (envelope.status === "accepted") {
    return { ok: false, error: { code: "ALREADY_ACCEPTED", handoffId: id } };
  }

  if (envelope.status === "expired") {
    return { ok: false, error: { code: "EXPIRED", handoffId: id } };
  }

  if (envelope.to !== config.agentId) {
    return {
      ok: false,
      error: {
        code: "TARGET_MISMATCH",
        expected: envelope.to,
        actual: config.agentId,
      },
    };
  }

  // Validate artifact refs — collect warnings (not hard fail)
  const artifactWarnings = validateArtifactRefs(envelope.context.artifacts);

  // Transition: pending|injected → accepted
  const updated = config.store.transition(envelope.id, envelope.status, "accepted");
  if (updated === undefined) {
    // CAS conflict — envelope changed between get and transition
    return { ok: false, error: { code: "NOT_FOUND", handoffId: id } };
  }

  return {
    ok: true,
    envelope: updated,
    warnings: artifactWarnings,
  };
}

function makeError(
  code: string,
  message: string,
): { readonly output: null; readonly metadata: JsonObject } {
  return {
    output: null,
    metadata: {
      error: { code, message, retryable: false },
    },
  };
}
