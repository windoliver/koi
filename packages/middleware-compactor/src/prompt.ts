/**
 * Summary prompt builder for LLM-based context compaction.
 *
 * Serializes messages into a structured prompt that instructs the
 * summarizer to produce a concise, structured summary.
 */

import type { InboundMessage } from "@koi/core/message";

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
 * Build a summary prompt from a sequence of messages.
 *
 * The prompt instructs the LLM to produce a structured summary with
 * sections for session intent, key events, artifacts, and next steps.
 */
export function buildSummaryPrompt(messages: readonly InboundMessage[], maxTokens: number): string {
  const serialized = messages.map(serializeMessage).join("\n");

  return `You are a conversation summarizer. Summarize the following conversation history into a structured summary. Your summary must fit within ${String(maxTokens)} tokens.

<conversation>
${serialized}
</conversation>

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
