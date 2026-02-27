/**
 * Keyset cursor encoding/decoding for paginated queries.
 *
 * Encodes (sortKey, rowid) pairs as URL-safe base64 strings.
 * Cursors are opaque to callers — only the registry can interpret them.
 */

/** Encode a keyset cursor from sort key and rowid. */
export function encodeCursor(sortKey: number, rowid: number): string {
  return Buffer.from(`${sortKey}:${rowid}`).toString("base64url");
}

/** Decode a keyset cursor back to sort key and rowid. Returns undefined on invalid input. */
export function decodeCursor(
  cursor: string,
): { readonly sortKey: number; readonly rowid: number } | undefined {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep === -1) return undefined;

    const sortKey = Number(decoded.slice(0, sep));
    const rowid = Number(decoded.slice(sep + 1));

    if (!Number.isFinite(sortKey) || !Number.isFinite(rowid)) return undefined;
    return { sortKey, rowid };
  } catch {
    return undefined;
  }
}
