/**
 * Shared path encoding for ATIF document IDs → filenames.
 *
 * Uses percent-encoding so the mapping is injective —
 * different docIds always produce different filenames.
 */

const EXTENSION = ".atif.json";

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
