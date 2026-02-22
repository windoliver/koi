export interface ChunkerConfig {
  readonly chunkSize: number;
  readonly chunkOverlap: number;
}

export interface Chunk {
  readonly text: string;
  readonly index: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

const DEFAULT_CONFIG: ChunkerConfig = {
  chunkSize: 1600,
  chunkOverlap: 320,
} as const;

const SEPARATORS = ["\n\n", "\n", ". ", " "] as const;

/**
 * Recursive character text splitter.
 * Attempts to split on paragraph → newline → sentence → word boundaries.
 */
export function chunk(text: string, config?: Partial<ChunkerConfig>): readonly Chunk[] {
  const { chunkSize, chunkOverlap } = { ...DEFAULT_CONFIG, ...config };
  if (text.length === 0) return [];
  if (text.length <= chunkSize) {
    return [{ text, index: 0, startOffset: 0, endOffset: text.length }];
  }
  const segments = splitRecursive(text, chunkSize, 0);
  return mergeWithOverlap(segments, chunkSize, chunkOverlap);
}

function splitRecursive(text: string, chunkSize: number, separatorIdx: number): readonly string[] {
  if (text.length <= chunkSize) return [text];

  const separator = SEPARATORS[separatorIdx];
  if (separator === undefined) {
    // Last resort: split at chunkSize boundary
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      parts.push(text.slice(i, i + chunkSize));
    }
    return parts;
  }

  const parts = text.split(separator);
  const merged: string[] = [];
  let current = "";

  for (const part of parts) {
    const candidate = current.length === 0 ? part : current + separator + part;
    if (candidate.length <= chunkSize) {
      current = candidate;
    } else {
      if (current.length > 0) merged.push(current);
      if (part.length > chunkSize) {
        merged.push(...splitRecursive(part, chunkSize, separatorIdx + 1));
        current = "";
      } else {
        current = part;
      }
    }
  }
  if (current.length > 0) merged.push(current);

  return merged;
}

function mergeWithOverlap(
  segments: readonly string[],
  chunkSize: number,
  overlap: number,
): readonly Chunk[] {
  if (overlap === 0 || segments.length <= 1) {
    let offset = 0;
    return segments.map((text, index) => {
      const c: Chunk = { text, index, startOffset: offset, endOffset: offset + text.length };
      offset += text.length;
      return c;
    });
  }

  const chunks: Chunk[] = [];
  let globalOffset = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    let text = seg;

    // Prepend overlap from previous segment
    if (i > 0) {
      const prev = segments[i - 1];
      if (prev !== undefined) {
        const overlapText = prev.slice(Math.max(0, prev.length - overlap));
        text = overlapText + text;
      }
    }

    // Truncate to chunkSize
    if (text.length > chunkSize) {
      text = text.slice(0, chunkSize);
    }

    const prevLen = i > 0 ? (segments[i - 1]?.length ?? 0) : 0;
    const startOffset = i === 0 ? 0 : globalOffset - Math.min(overlap, prevLen);
    chunks.push({
      text,
      index: i,
      startOffset,
      endOffset: startOffset + text.length,
    });
    globalOffset += seg.length;
  }

  return chunks;
}
