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
 * Locate the longest user text block strictly larger than `minChars`.
 * Returns `undefined` when every user text block is already within bounds —
 * the caller signals "nothing left to chunk".
 */
function findLargestOversizedTextBlock(
  messages: readonly InboundMessage[],
  minChars: number,
): TargetLocation | undefined {
  let best: TargetLocation | undefined;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined) continue;
    if (msg.senderId !== "user") continue;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (block === undefined || block.kind !== "text") continue;
      if (block.text.length <= minChars) continue;
      if (best === undefined || block.text.length > best.text.length) {
        best = { messageIndex: i, blockIndex: j, text: block.text };
      }
    }
  }
  return best;
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
 * Segment a request into N requests by iteratively splitting every user text
 * block that exceeds `maxChunkChars`. The user payload is rewritten verbatim
 * with the chunk text only — no synthetic ordinal labels — so exact-copy and
 * structured-transformation prompts remain byte-safe.
 *
 * Recursion: after splitting the largest oversized block, every produced
 * segment is fed back through `segmentRequest`, so a request with multiple
 * oversized text blocks fans out into the cross product of their chunks
 * rather than rejecting valid multi-block input. Returns `[request]`
 * unchanged when every user text block already fits within `maxChunkChars`.
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
  const target = findLargestOversizedTextBlock(request.messages, maxChunkChars);
  if (target === undefined) return [request];
  const chunks = splitText(target.text, maxChunkChars);
  if (chunks.length <= 1) return [request];

  const out: ModelRequest[] = [];
  for (const chunk of chunks) {
    const messages = replaceTextBlock(request.messages, target, chunk);
    const reduced: ModelRequest = { ...request, messages };
    // The chunked block may not have been the only oversized one; recurse
    // on this reduced request so multi-block oversized inputs fan out
    // across every offending block instead of failing closed downstream.
    for (const sub of segmentRequest(reduced, maxChunkChars)) out.push(sub);
  }
  return out;
}
