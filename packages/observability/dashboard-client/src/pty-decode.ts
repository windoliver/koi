/**
 * Decode base64-encoded PTY chunks to a single Uint8Array.
 *
 * Extracted from tui-root.tsx for reuse across views.
 */

/** Decode an array of base64 PTY chunks into a merged Uint8Array. */
export function decodePtyChunks(chunks: readonly string[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);

  const parts: Uint8Array[] = [];
  for (const chunk of chunks) {
    parts.push(Uint8Array.from(Buffer.from(chunk, "base64")));
  }

  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}
