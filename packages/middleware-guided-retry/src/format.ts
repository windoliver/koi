/**
 * Formats a BacktrackConstraint as an InboundMessage for model injection.
 */

import type { BacktrackConstraint, InboundMessage } from "@koi/core";

/**
 * Formats a BacktrackConstraint as a system-level inbound message.
 *
 * The message explains why a backtrack occurred and provides guidance
 * so the model can avoid repeating the same mistake.
 */
export function formatConstraintMessage(constraint: BacktrackConstraint): InboundMessage {
  const lines: readonly string[] = [
    "[BACKTRACK GUIDANCE] A previous attempt was abandoned.",
    `Reason: ${constraint.reason.kind} \u2014 ${constraint.reason.message}`,
    ...(constraint.instructions !== undefined ? [`Guidance: ${constraint.instructions}`] : []),
  ];

  const text = lines.join("\n");

  return {
    senderId: "system:guided-retry",
    content: [{ kind: "text", text }] as const,
    timestamp: constraint.reason.timestamp,
  };
}
