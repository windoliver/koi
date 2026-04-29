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
 * Locate the longest text block across all user messages. Returns
 * `undefined` if no text block exists.
 */
function findLargestTextBlock(messages: readonly InboundMessage[]): TargetLocation | undefined {
  let best: TargetLocation | undefined;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined) continue;
    if (msg.senderId !== "user") continue;
    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j];
      if (block === undefined || block.kind !== "text") continue;
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
 * Segment a request into N requests, each with one chunk of the largest
 * user text block. Returns `[request]` unchanged if no text block can be
 * segmented (no user text or the block already fits).
 */
export function segmentRequest(
  request: ModelRequest,
  maxChunkChars: number,
): readonly ModelRequest[] {
  const target = findLargestTextBlock(request.messages);
  if (target === undefined) return [request];
  if (target.text.length <= maxChunkChars) return [request];

  const chunks = splitText(target.text, maxChunkChars);
  if (chunks.length <= 1) return [request];

  return chunks.map((chunk, i) => {
    const annotated = `Segment ${i + 1}/${chunks.length}:\n${chunk}`;
    const messages = replaceTextBlock(request.messages, target, annotated);
    return { ...request, messages };
  });
}
