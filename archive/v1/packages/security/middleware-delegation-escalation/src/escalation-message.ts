/**
 * Pure function to generate a human-readable escalation message
 * sent via the channel when all delegatees are exhausted.
 */

import type { OutboundMessage } from "@koi/core";
import type { EscalationContext } from "./types.js";

/**
 * Generates an OutboundMessage describing the exhaustion condition
 * for a human operator. Includes delegatee list and optional task summary.
 *
 * @param correlationToken - When provided, embedded in metadata so the
 *   escalation gate can filter responses by this token.
 */
export function generateEscalationMessage(
  ctx: EscalationContext,
  correlationToken?: string,
): OutboundMessage {
  const delegateeList = ctx.exhaustedDelegateeIds.map((id) => `  - ${id}`).join("\n");

  const summarySection =
    ctx.taskSummary !== undefined ? `\n\nTask summary:\n${ctx.taskSummary}` : "";

  const text = [
    `[Escalation] All delegatees for agent "${ctx.issuerId}" have exhausted their circuit breakers.`,
    "",
    `Exhausted delegatees:\n${delegateeList}`,
    summarySection,
    "",
    'Please reply with instructions to resume, or type "abort" to stop the agent.',
  ].join("\n");

  return {
    content: [{ kind: "text", text }],
    metadata: {
      escalation: true,
      issuerId: ctx.issuerId,
      detectedAt: ctx.detectedAt,
      delegateeCount: ctx.exhaustedDelegateeIds.length,
      ...(correlationToken !== undefined ? { correlationToken } : {}),
    },
  };
}
