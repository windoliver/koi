/**
 * Deterministic SHA-256 content hash for arbitrary data.
 *
 * Produces identical hashes for semantically equivalent objects regardless
 * of key insertion order. Uses Bun.CryptoHasher (sync, no Web Crypto overhead).
 */

/**
 * Deterministically serialize a value to a string suitable for hashing.
 * Objects have their keys sorted recursively; arrays preserve element order.
 */
function deterministicSerialize(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map(deterministicSerialize);
    return `[${items.join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${deterministicSerialize(obj[key])}`,
  );
  return `{${entries.join(",")}}`;
}

/**
 * Compute a deterministic SHA-256 content hash for arbitrary data.
 *
 * @param data - Any JSON-serializable value.
 * @returns 64-character lowercase hex digest.
 */
export function computeContentHash(data: unknown): string {
  const serialized = deterministicSerialize(data);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(serialized);
  return hasher.digest("hex");
}

/**
 * Compute a SHA-256 hex digest of a raw string.
 *
 * Unlike {@link computeContentHash}, this does NOT do deterministic
 * serialization — the string is hashed as-is. Use this for content
 * that is already in its canonical string form (e.g., surface content).
 *
 * @param content - The raw string to hash.
 * @returns 64-character lowercase hex digest.
 */
export function computeStringHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}
