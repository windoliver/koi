/**
 * Generate concise prompt summaries from handoff envelopes.
 */

import type { HandoffEnvelope } from "@koi/core";

/**
 * Generate a system prompt summary from a handoff envelope.
 * Designed to be ~200-400 tokens — enough context for the agent
 * to understand its task without overloading the context window.
 * Full details are available via the accept_handoff tool.
 */
export function generateHandoffSummary(envelope: HandoffEnvelope): string {
  const lines: string[] = [
    "## Handoff Context",
    `You are continuing work from agent \`${envelope.from}\`.`,
    "",
    "### Completed Phase",
    envelope.phase.completed,
    "",
    "### Your Task",
    envelope.phase.next,
  ];

  if (envelope.context.warnings.length > 0) {
    lines.push("", "### Warnings");
    for (const warning of envelope.context.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  const artifactCount = envelope.context.artifacts.length;
  const decisionCount = envelope.context.decisions.length;

  lines.push("", "### Available Context");
  if (artifactCount > 0) {
    lines.push(`- ${String(artifactCount)} artifact${artifactCount === 1 ? "" : "s"} available`);
  }
  if (decisionCount > 0) {
    lines.push(`- ${String(decisionCount)} decision record${decisionCount === 1 ? "" : "s"}`);
  }
  lines.push(
    `- Use \`accept_handoff\` tool with id="${envelope.id}" to retrieve full results and artifacts.`,
  );

  return lines.join("\n");
}
