/**
 * Splits text into TTS-friendly chunks using Intl.Segmenter sentence boundaries.
 *
 * Produces chunks that balance natural speech pauses with minimum size
 * constraints, so TTS can start synthesizing the first chunk while the
 * LLM is still generating the rest.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

/** Clause-boundary pattern for splitting oversized sentences. */
const CLAUSE_BOUNDARY = /[,;:\u2014]\s+/;

function countWords(text: string): number {
  // Handles Latin, CJK (each character ≈ 1 word), and mixed text
  const stripped = text.trim();
  if (stripped.length === 0) return 0;
  return stripped.split(/\s+/).length;
}

function splitAtWordBoundary(text: string, maxChars: number): readonly [string, string] {
  if (text.length <= maxChars) return [text, ""];
  // Find last space at or before maxChars
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace <= 0) {
    // No space found — hard split at maxChars
    return [text.slice(0, maxChars), text.slice(maxChars)];
  }
  return [text.slice(0, lastSpace), text.slice(lastSpace + 1)];
}

export interface ChunkTtsOptions {
  readonly minChunkWords?: number;
  readonly maxChunkChars?: number;
}

/**
 * Split text into TTS-optimized chunks.
 *
 * 1. Pre-split on newlines
 * 2. Sentence-segment each line via `Intl.Segmenter`
 * 3. Merge short sentences below `minChunkWords`
 * 4. Split oversized chunks at clause or word boundaries
 */
export function chunkTtsInput(text: string, options?: ChunkTtsOptions): readonly string[] {
  const minWords = options?.minChunkWords ?? 3;
  const maxChars = options?.maxChunkChars ?? 200;

  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  // Pre-split on newlines, then sentence-segment each line
  const lines = trimmed.split(/\n+/);
  const sentences: string[] = [];
  for (const line of lines) {
    const lineTrimmed = line.trim();
    if (lineTrimmed.length === 0) continue;
    for (const seg of segmenter.segment(lineTrimmed)) {
      const s = seg.segment.trim();
      if (s.length > 0) {
        sentences.push(s);
      }
    }
  }

  if (sentences.length === 0) return [];

  // Merge pass: combine short sentences below minChunkWords
  const merged: string[] = [];
  // let requires justification: accumulator buffer for merging short sentences
  let buffer = "";
  for (const sentence of sentences) {
    if (buffer.length === 0) {
      buffer = sentence;
    } else if (countWords(buffer) < minWords) {
      buffer = `${buffer} ${sentence}`;
    } else {
      merged.push(buffer);
      buffer = sentence;
    }
  }
  if (buffer.length > 0) {
    merged.push(buffer);
  }

  // Split pass: break oversized chunks
  const result: string[] = [];
  for (const chunk of merged) {
    if (chunk.length <= maxChars) {
      result.push(chunk);
      continue;
    }

    // Try splitting at clause boundary
    const clauseMatch = CLAUSE_BOUNDARY.exec(chunk);
    if (clauseMatch !== null && clauseMatch.index !== undefined) {
      const splitIdx = clauseMatch.index + clauseMatch[0].length - 1;
      const left = chunk.slice(0, splitIdx).trim();
      const right = chunk.slice(splitIdx).trim();
      if (
        left.length > 0 &&
        right.length > 0 &&
        countWords(left) >= minWords &&
        countWords(right) >= minWords
      ) {
        // Recursively split each half in case still oversized
        result.push(...chunkTtsInput(left, options));
        result.push(...chunkTtsInput(right, options));
        continue;
      }
    }

    // Fall back to word-boundary split at maxChars
    // let requires justification: remainder shrinks as we split off pieces
    let remainder = chunk;
    while (remainder.length > maxChars) {
      const [head, tail] = splitAtWordBoundary(remainder, maxChars);
      if (head.length > 0) result.push(head);
      if (tail.length === 0) break;
      remainder = tail;
    }
    if (remainder.trim().length > 0) {
      result.push(remainder.trim());
    }
  }

  return result;
}
