/**
 * InputStore — virtualized input storage for RLM.
 *
 * Holds the raw input text in a closure and provides methods to examine
 * slices, generate chunk descriptors, and compute metadata with format
 * detection and structure hints.
 */

import { estimateTokens } from "@koi/token-estimator";
import type { ChunkDescriptor, InputFormat, InputMetadata } from "./types.js";
import { DEFAULT_CHUNK_SIZE, DEFAULT_MAX_INPUT_BYTES, DEFAULT_PREVIEW_LENGTH } from "./types.js";

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/** Detect the format of input text using simple heuristics. */
export function detectFormat(input: string): InputFormat {
  const trimmed = input.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(input);
      return "json";
    } catch {
      // Not valid JSON, continue checks
    }
  }
  if (/^#{1,6}\s/m.test(input) || /^```/m.test(input)) {
    return "markdown";
  }
  // CSV: first line has commas or tabs separating fields, and at least 2 lines
  const lines = input.split("\n");
  if (lines.length >= 2) {
    const firstLine = lines[0] ?? "";
    if (
      (firstLine.includes(",") && firstLine.split(",").length >= 2) ||
      (firstLine.includes("\t") && firstLine.split("\t").length >= 2)
    ) {
      return "csv";
    }
  }
  return "plaintext";
}

// ---------------------------------------------------------------------------
// Structure hints extraction
// ---------------------------------------------------------------------------

/** Extract structure hints based on detected format. */
export function extractStructureHints(input: string, format: InputFormat): readonly string[] {
  switch (format) {
    case "json": {
      try {
        const parsed: unknown = JSON.parse(input);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return Object.keys(parsed as Record<string, unknown>);
        }
      } catch {
        // Malformed JSON
      }
      return [];
    }
    case "csv": {
      const firstLine = input.split("\n")[0] ?? "";
      const separator = firstLine.includes("\t") ? "\t" : ",";
      return firstLine.split(separator).map((h) => h.trim());
    }
    case "markdown": {
      const headings: string[] = [];
      for (const line of input.split("\n")) {
        if (/^#{1,6}\s/.test(line)) {
          headings.push(line.trim());
        }
      }
      return headings;
    }
    case "plaintext":
      return [];
    default: {
      const _exhaustive: never = format;
      throw new Error(`Unhandled format: ${_exhaustive}`);
    }
  }
}

// ---------------------------------------------------------------------------
// InputStore
// ---------------------------------------------------------------------------

export interface InputStoreOptions {
  readonly maxInputBytes?: number | undefined;
  readonly chunkSize?: number | undefined;
  readonly previewLength?: number | undefined;
}

export interface InputStore {
  /** Get metadata about the virtualized input. Cached after first call. */
  readonly metadata: () => InputMetadata;
  /** Read a slice of the input. Returns empty string if out of bounds. */
  readonly examine: (offset: number, length: number) => string;
  /** Get chunk descriptors for the given index range (inclusive). */
  readonly chunkDescriptors: (startIndex: number, endIndex: number) => readonly ChunkDescriptor[];
  /** Total length of the input in characters. */
  readonly length: number;
}

/**
 * Creates an InputStore wrapping the given input text.
 *
 * @throws {Error} if input exceeds maxInputBytes
 */
export function createInputStore(input: string, options?: InputStoreOptions): InputStore {
  const maxInputBytes = options?.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const previewLength = options?.previewLength ?? DEFAULT_PREVIEW_LENGTH;

  const inputBytes = new TextEncoder().encode(input).length;
  if (inputBytes > maxInputBytes) {
    throw new Error(
      `Input size (${String(inputBytes)} bytes) exceeds maximum (${String(maxInputBytes)} bytes)`,
    );
  }

  const totalChunks = Math.max(1, Math.ceil(input.length / chunkSize));

  // Lazy-cached metadata
  // let: set once on first metadata() call
  let cachedMetadata: InputMetadata | undefined;

  function metadata(): InputMetadata {
    if (cachedMetadata !== undefined) return cachedMetadata;

    const format = detectFormat(input);
    const structureHints = extractStructureHints(input, format);
    const preview = input.length <= previewLength ? input : input.slice(0, previewLength);

    cachedMetadata = {
      format,
      sizeBytes: inputBytes,
      estimatedTokens: estimateTokens(input),
      totalChunks,
      structureHints,
      preview,
    };
    return cachedMetadata;
  }

  function examine(offset: number, length: number): string {
    if (offset >= input.length || offset < 0) return "";
    const end = Math.min(offset + length, input.length);
    return input.slice(offset, end);
  }

  function chunkDescriptors(startIndex: number, endIndex: number): readonly ChunkDescriptor[] {
    const clampedStart = Math.max(0, startIndex);
    const clampedEnd = Math.min(totalChunks - 1, endIndex);
    if (clampedStart > clampedEnd || clampedStart >= totalChunks) return [];

    const descriptors: ChunkDescriptor[] = [];
    for (let i = clampedStart; i <= clampedEnd; i++) {
      const offset = i * chunkSize;
      const length = Math.min(chunkSize, input.length - offset);
      const chunkPreview = input.slice(offset, offset + Math.min(previewLength, length));
      descriptors.push({
        index: i,
        offset,
        length,
        preview: chunkPreview,
      });
    }
    return descriptors;
  }

  return {
    metadata,
    examine,
    chunkDescriptors,
    length: input.length,
  };
}
