/**
 * Pure segmentation: split a `ModelRequest` whose largest user text block
 * exceeds the chunk size into N requests, each carrying one chunk.
 *
 * The remainder of the message graph (system prompt, prior turns, non-text
 * blocks, tools) is preserved verbatim so downstream middleware sees the
 * same context per call.
 */

import type { ContentBlock, InboundMessage, ModelRequest, TextBlock } from "@koi/core";

/** Locator for the text block selected for chunking. */
interface TargetLocation {
  readonly messageIndex: number;
  readonly blockIndex: number;
  readonly text: string;
}

/**
 * True for any message that the model adapter treats as user-role content.
 * Mirrors `mapSenderIdToRole`: everything except `assistant` and
 * `system*` is user content, so middleware-authored senders such as
 * `watch-patterns` and `user:1` are eligible for chunking just like
 * literal `"user"` messages.
 */
/**
 * True for any message that the openai-compat adapter resolves as user
 * role under trusted-mode L1 conventions. RLM lives downstream of the
 * engine, so trusted-mode is the correct assumption — and middleware
 * MUST NOT chunk assistant/tool/system content even when senderId looks
 * neutral.
 *
 * Resolution order mirrors `resolveRole` in `model-openai-compat`:
 *   1. system:* senderIds → system (never user-role)
 *   2. metadata.role override (trusted) for assistant/tool/user
 *   3. senderId === "assistant" or "tool" heuristic
 *   4. default user
 */
function isUserRoleMessage(msg: InboundMessage): boolean {
  // The two canonical resolvers in this repo disagree on bare
  // `senderId === "system"`: openai-compat treats it as user; the
  // shared model-router normalizer treats it as system. Take the
  // conservative trust-boundary stance and exclude bare "system" from
  // chunking — letting RLM rewrite privileged instructions chunk-by-
  // chunk would be a real security regression on any cross-middleware
  // path that treats bare "system" as system content. Oversized bare-
  // system content is a compaction concern, not RLM's.
  if (msg.senderId === "system" || msg.senderId.startsWith("system:")) return false;
  if (msg.metadata !== undefined) {
    const role = msg.metadata.role;
    if (role === "assistant" || role === "tool") return false;
    if (role === "user") return true;
  }
  if (msg.senderId === "assistant" || msg.senderId === "tool") return false;
  return true;
}

/**
 * Collect every user-role text block strictly larger than `minChars`,
 * sorted longest-first. The caller decides whether to chunk the largest,
 * fail closed because more than one oversized block exists, or pass the
 * request through.
 */
function findOversizedTextBlocks(
  messages: readonly InboundMessage[],
  minChars: number,
): readonly TargetLocation[] {
  const out: TargetLocation[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined) continue;
    if (!isUserRoleMessage(msg)) continue;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (block === undefined || block.kind !== "text") continue;
      if (block.text.length <= minChars) continue;
      out.push({ messageIndex: i, blockIndex: j, text: block.text });
    }
  }
  return out.toSorted((a, b) => b.text.length - a.text.length);
}

/**
 * Error thrown by `segmentRequest` when more than one user-role text block
 * is over `maxChunkChars`. RLM's segmentation strategy can only partition
 * one block at a time — fanning out across the cross product would
 * duplicate content and answers, and a true multi-block partition would
 * require an explicit reducer stage that is out of scope for this package.
 */
export class MultipleOversizedBlocksError extends Error {
  readonly blockCount: number;
  constructor(blockCount: number) {
    super(
      `RLM cannot segment requests with multiple oversized user text blocks (${String(
        blockCount,
      )} blocks > maxChunkChars). Fanning out across the cross product would duplicate work and corrupt reassembly. Combine the blocks upstream, raise maxChunkChars, or use a compaction middleware.`,
    );
    this.name = "MultipleOversizedBlocksError";
    this.blockCount = blockCount;
  }
}

/**
 * Split text into chunks no larger than `maxChars`, preferring paragraph,
 * then line, then hard-cut boundaries. Output chunks concatenated with the
 * separators they were split on reproduce the input.
 */
export function splitText(text: string, maxChars: number): readonly string[] {
  if (maxChars <= 0) {
    throw new Error(`maxChars must be positive, got ${maxChars}`);
  }
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/(\n\n+)/);
  const chunks: string[] = [];
  let current = ""; // let: accumulator while folding paragraphs into chunks
  for (const part of paragraphs) {
    if ((current + part).length <= maxChars) {
      current += part;
      continue;
    }
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
    if (part.length <= maxChars) {
      current = part;
      continue;
    }
    for (const piece of splitByLines(part, maxChars)) {
      if ((current + piece).length <= maxChars) {
        current += piece;
        continue;
      }
      if (current.length > 0) chunks.push(current);
      current = piece;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Split a paragraph on newline boundaries; hard-cut lines that themselves overflow. */
function splitByLines(text: string, maxChars: number): readonly string[] {
  if (text.length <= maxChars) return [text];
  const lines = text.split(/(\n)/);
  const out: string[] = [];
  let current = ""; // let: line-level accumulator
  for (const line of lines) {
    if ((current + line).length <= maxChars) {
      current += line;
      continue;
    }
    if (current.length > 0) {
      out.push(current);
      current = "";
    }
    if (line.length <= maxChars) {
      current = line;
      continue;
    }
    for (let k = 0; k < line.length; k += maxChars) {
      const piece = line.slice(k, k + maxChars);
      if ((current + piece).length <= maxChars) {
        current += piece;
      } else {
        if (current.length > 0) out.push(current);
        current = piece;
      }
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Replace the text of the block at `(messageIndex, blockIndex)` with `text`.
 * All other messages and blocks are returned by reference.
 */
function replaceTextBlock(
  messages: readonly InboundMessage[],
  loc: TargetLocation,
  text: string,
): readonly InboundMessage[] {
  return messages.map((msg, i) => {
    if (i !== loc.messageIndex) return msg;
    const content: ContentBlock[] = msg.content.map((block, j) => {
      if (j !== loc.blockIndex) return block;
      const replaced: TextBlock = { kind: "text", text };
      return replaced;
    });
    return { ...msg, content };
  });
}

/**
 * Segment a request into N requests by splitting the single user-role text
 * block that exceeds `maxChunkChars`. The user payload is rewritten
 * verbatim with the chunk text only — no synthetic ordinal labels — so
 * exact-copy and structured-transformation prompts remain byte-safe.
 *
 * Returns `[request]` unchanged when no user-role text block exceeds the
 * chunk size. Throws {@link MultipleOversizedBlocksError} when more than
 * one user-role text block does: a true partition across multiple blocks
 * would require a reducer stage that is out of scope for this package,
 * and a cross-product fan-out would duplicate content and answers.
 *
 * Per-segment ordinal information is intentionally not threaded into the
 * `ModelRequest` — the caller (RLM middleware) sees the flat list and
 * reconstructs ordering through reassembly metadata, keeping the user
 * payload free of middleware bookkeeping.
 */
export function segmentRequest(
  request: ModelRequest,
  maxChunkChars: number,
): readonly ModelRequest[] {
  const oversized = findOversizedTextBlocks(request.messages, maxChunkChars);
  if (oversized.length === 0) return [request];
  if (oversized.length > 1) throw new MultipleOversizedBlocksError(oversized.length);

  const target = oversized[0];
  if (target === undefined) return [request];
  const chunks = splitText(target.text, maxChunkChars);
  if (chunks.length <= 1) return [request];

  return chunks.map((chunk) => {
    const messages = replaceTextBlock(request.messages, target, chunk);
    return { ...request, messages };
  });
}
