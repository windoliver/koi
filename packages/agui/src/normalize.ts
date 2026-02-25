/**
 * RunAgentInput → InboundMessage normalizer.
 *
 * Two modes:
 *
 *   "stateful"  (default) — only the last user message becomes the InboundMessage
 *               content. Assumes the Koi engine has its own memory middleware that
 *               maintains conversation history across turns.
 *
 *   "stateless" — all messages are flattened into labeled TextBlocks so the engine
 *                 sees the full history on every request. Use when there is no
 *                 memory middleware in the stack.
 *
 * In both modes:
 *   - `threadId` → InboundMessage.threadId
 *   - `runId`    → metadata.runId (used by channel for SSE routing)
 *   - `state`    → metadata.aguiState (CopilotKit shared state)
 */

import type { RunAgentInput } from "@ag-ui/core";
import type { ContentBlock, InboundMessage } from "@koi/core";

export type NormalizationMode = "stateful" | "stateless";

type AguiMessage = RunAgentInput["messages"][number];

/** Extract plain text from an AG-UI message content (string or content-block array). */
export function extractMessageText(
  content: string | readonly { readonly type: string; readonly text?: string }[],
): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter(
      (block): block is { readonly type: "text"; readonly text: string } =>
        block.type === "text" && typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/**
 * Normalize a RunAgentInput into a Koi InboundMessage.
 *
 * Returns null if there are no processable messages to dispatch — callers should
 * respond with HTTP 400 in that case.
 */
export function normalizeRunAgentInput(
  input: RunAgentInput,
  mode: NormalizationMode,
): InboundMessage | null {
  const { threadId, runId, messages, state } = input;

  const metadata: Record<string, unknown> = { runId };
  if (state !== undefined && state !== null) {
    metadata.aguiState = state;
  }

  if (mode === "stateful") {
    return normalizeStateful(messages, threadId, metadata);
  }
  return normalizeStateless(messages, threadId, metadata);
}

function normalizeStateful(
  messages: readonly AguiMessage[],
  threadId: string,
  metadata: Record<string, unknown>,
): InboundMessage | null {
  // Walk backwards to find the last user message.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === undefined || msg.role !== "user") {
      continue;
    }
    const content = (msg as { content?: string | readonly { type: string; text?: string }[] })
      .content;
    const text = content !== undefined ? extractMessageText(content) : "";
    return {
      content: [{ kind: "text", text }],
      senderId: threadId,
      threadId,
      timestamp: Date.now(),
      metadata,
    };
  }
  return null;
}

function normalizeStateless(
  messages: readonly AguiMessage[],
  threadId: string,
  metadata: Record<string, unknown>,
): InboundMessage | null {
  if (messages.length === 0) {
    return null;
  }

  const blocks: ContentBlock[] = [];
  for (const msg of messages) {
    // Only include roles that carry text content relevant to the conversation.
    if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "system") {
      continue;
    }
    const content = (msg as { content?: string | readonly { type: string; text?: string }[] })
      .content;
    const text = content !== undefined ? extractMessageText(content) : "";
    if (text.length > 0) {
      blocks.push({ kind: "text", text: `[${msg.role}]: ${text}` });
    }
  }

  if (blocks.length === 0) {
    return null;
  }

  return {
    content: blocks,
    senderId: threadId,
    threadId,
    timestamp: Date.now(),
    metadata,
  };
}
