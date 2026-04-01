/**
 * IPC payload types for agent-to-agent approval routing.
 *
 * Defines the wire format and Zod schemas for exec-approval request/response
 * messages exchanged between child and parent agents via MailboxComponent.
 *
 * All exported types are declared explicitly (isolatedDeclarations compatible).
 * Zod schemas are module-private; validation is exposed via validateWith wrappers.
 */

import type { JsonObject } from "@koi/core/common";
import type { KoiError, Result } from "@koi/core/errors";
import { validateWith } from "@koi/validation";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Message type discriminator for exec-approval IPC messages. */
export const EXEC_APPROVAL_REQUEST_TYPE = "exec-approval-request" as const;

// ---------------------------------------------------------------------------
// Request payload (child → parent)
// ---------------------------------------------------------------------------

/** IPC payload sent from child to parent requesting approval. */
export interface ExecApprovalIpcPayload {
  readonly toolId: string;
  readonly input: JsonObject;
  readonly matchedPattern: string;
  readonly childAgentId: string;
  readonly riskAnalysis?:
    | {
        readonly riskLevel: "low" | "medium" | "high" | "critical" | "unknown";
        readonly rationale: string;
      }
    | undefined;
}

const execApprovalIpcPayloadSchema = z.object({
  toolId: z.string(),
  input: z.record(z.string(), z.unknown()),
  matchedPattern: z.string(),
  childAgentId: z.string(),
  riskAnalysis: z
    .object({
      riskLevel: z.enum(["low", "medium", "high", "critical", "unknown"]),
      rationale: z.string(),
    })
    .optional(),
});

/** Validate an unknown value as an ExecApprovalIpcPayload. */
export function validateExecApprovalIpcPayload(
  raw: unknown,
): Result<ExecApprovalIpcPayload, KoiError> {
  return validateWith(
    execApprovalIpcPayloadSchema,
    raw,
    "Exec-approval IPC payload validation failed",
  ) as Result<ExecApprovalIpcPayload, KoiError>;
}

// ---------------------------------------------------------------------------
// Response payload (parent → child)
// ---------------------------------------------------------------------------

/** Decision kind returned by parent agent. */
export type ExecApprovalDecisionKind =
  | "allow_once"
  | "allow_session"
  | "allow_always"
  | "deny_once"
  | "deny_always"
  | "ask";

/** IPC response payload sent from parent to child with approval decision. */
export interface ExecApprovalIpcResponse {
  readonly decision: {
    readonly kind: ExecApprovalDecisionKind;
    readonly pattern?: string | undefined;
    readonly reason?: string | undefined;
  };
}

const execApprovalIpcResponseSchema = z.object({
  decision: z.object({
    kind: z.enum([
      "allow_once",
      "allow_session",
      "allow_always",
      "deny_once",
      "deny_always",
      "ask",
    ]),
    pattern: z.string().optional(),
    reason: z.string().optional(),
  }),
});

/** Validate an unknown value as an ExecApprovalIpcResponse. */
export function validateExecApprovalIpcResponse(
  raw: unknown,
): Result<ExecApprovalIpcResponse, KoiError> {
  return validateWith(
    execApprovalIpcResponseSchema,
    raw,
    "Exec-approval IPC response validation failed",
  ) as Result<ExecApprovalIpcResponse, KoiError>;
}
