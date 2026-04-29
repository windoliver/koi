/**
 * Shared path encoding for ATIF document IDs → filenames.
 *
 * Uses percent-encoding so the mapping is injective —
 * different docIds always produce different filenames.
 */

const EXTENSION = ".atif.json";
const METADATA_EXTENSION = ".atif.meta.json";
const STEP_CHUNK_PREFIX = ".atif.steps.";
const STEP_CHUNK_EXTENSION = ".json";
const STEP_CHUNK_INDEX_WIDTH = 12;

/**
 * Encode a docId for use as a filename using encodeURIComponent.
 * Handles all Unicode (emoji, CJK, etc.) correctly.
 * Additionally encodes dots to prevent hidden files on Unix.
 */
export function encodeDocId(docId: string): string {
  return encodeURIComponent(docId).replace(/\./g, "%2E");
}

/** Decode a filename back to the original docId. Returns undefined for malformed percent escapes. */
export function decodeDocId(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

/** Build a filename from a docId. */
export function docIdToFilename(docId: string): string {
  return `${encodeDocId(docId)}${EXTENSION}`;
}

/** Extract the docId from a filename, or undefined if not an ATIF file or malformed. */
export function filenameToDocId(filename: string): string | undefined {
  if (!filename.endsWith(EXTENSION)) return undefined;
  return decodeDocId(filename.slice(0, -EXTENSION.length));
}

/** Build the chunked-store metadata filename for a docId. */
export function docIdToMetadataFilename(docId: string): string {
  return `${encodeDocId(docId)}${METADATA_EXTENSION}`;
}

/** Extract the docId from a chunked-store metadata filename. */
export function metadataFilenameToDocId(filename: string): string | undefined {
  if (!filename.endsWith(METADATA_EXTENSION)) return undefined;
  return decodeDocId(filename.slice(0, -METADATA_EXTENSION.length));
}

/** Build a filename for a chunk of ATIF steps starting at the given step id. */
export function docIdToStepChunkFilename(docId: string, startIndex: number): string {
  return `${encodeDocId(docId)}${STEP_CHUNK_PREFIX}${formatStepChunkIndex(startIndex)}${STEP_CHUNK_EXTENSION}`;
}

/** Glob fragment for all step chunks belonging to a docId. */
export function docIdToStepChunkGlob(docId: string): string {
  return `${encodeDocId(docId)}${STEP_CHUNK_PREFIX}*${STEP_CHUNK_EXTENSION}`;
}

/** Parse a chunk filename into its docId and starting step id. */
export function stepChunkFilenameToInfo(
  filename: string,
): { readonly docId: string; readonly startIndex: number } | undefined {
  if (!filename.endsWith(STEP_CHUNK_EXTENSION)) return undefined;
  const withoutExtension = filename.slice(0, -STEP_CHUNK_EXTENSION.length);
  const markerIndex = withoutExtension.lastIndexOf(STEP_CHUNK_PREFIX);
  if (markerIndex < 0) return undefined;

  const encodedDocId = withoutExtension.slice(0, markerIndex);
  const rawIndex = withoutExtension.slice(markerIndex + STEP_CHUNK_PREFIX.length);
  if (!/^\d+$/.test(rawIndex)) return undefined;

  const docId = decodeDocId(encodedDocId);
  if (docId === undefined) return undefined;

  return { docId, startIndex: Number(rawIndex) };
}

function formatStepChunkIndex(startIndex: number): string {
  const safeIndex = Number.isFinite(startIndex) && startIndex > 0 ? Math.floor(startIndex) : 0;
  return String(safeIndex).padStart(STEP_CHUNK_INDEX_WIDTH, "0");
}
