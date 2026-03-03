/**
 * Summary prompt builder for LLM-based context compaction.
 *
 * Serializes messages into a structured prompt that instructs the
 * summarizer to produce a concise, structured summary.
 */

import type { InboundMessage } from "@koi/core/message";
import type { CapabilityFragment } from "@koi/core/middleware";

const MAX_MESSAGE_CHARS = 2000;

/** Serialize a single message into a text representation. */
function serializeMessage(msg: InboundMessage): string {
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.kind === "text") {
      const text =
        block.text.length > MAX_MESSAGE_CHARS
          ? `${block.text.slice(0, MAX_MESSAGE_CHARS)}...[truncated]`
          : block.text;
      parts.push(text);
    }
  }
  return `[${msg.senderId}] ${parts.join(" ")}`;
}

/**
 * Formats convention fragments into a text block for injection into summaries.
 * Returns empty string when the array is empty.
 */
export function formatConventionBlock(conventions: readonly CapabilityFragment[]): string {
  if (conventions.length === 0) return "";
  const lines = conventions.map((c) => `- **${c.label}**: ${c.description}`);
  return `[Conventions]\n${lines.join("\n")}`;
}

/**
 * Build a summary prompt from a sequence of messages.
 *
 * The prompt instructs the LLM to produce a structured summary with
 * sections for session intent, key events, artifacts, and next steps.
 *
 * When conventions are provided, a CONVENTIONS section is appended
 * instructing the LLM to preserve them verbatim in the summary.
 */
export function buildSummaryPrompt(
  messages: readonly InboundMessage[],
  maxTokens: number,
  conventions?: readonly CapabilityFragment[],
): string {
  const serialized = messages.map(serializeMessage).join("\n");

  const conventionSection =
    conventions !== undefined && conventions.length > 0
      ? `\n\n## CONVENTIONS (preserve verbatim)\n${conventions.map((c) => `- **${c.label}**: ${c.description}`).join("\n")}`
      : "";

  return `You are a conversation summarizer. Summarize the following conversation history into a structured summary. Your summary must fit within ${String(maxTokens)} tokens.

<conversation>
${serialized}
</conversation>${conventionSection}

Produce your summary in the following format:

## SESSION INTENT
One sentence describing the user's primary goal.

## SUMMARY
Concise bullet points of key decisions, actions taken, and outcomes. Preserve:
- Exact file paths, function names, and code identifiers
- Decisions made and their rationale
- Error messages and how they were resolved
- Configuration values and settings discussed

Discard:
- Redundant tool output (keep only final results)
- Verbose intermediate reasoning
- Repeated failed attempts (note the final resolution only)

## ARTIFACTS
List any files created, modified, or referenced (with paths).

## NEXT STEPS
What was the user about to do or asked to do next?`;
}
