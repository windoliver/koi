/**
 * SHA-256 hashing utility using Bun.CryptoHasher.
 *
 * Replaces ad-hoc HMAC/hash reimplementations flagged in #508.
 * Pure function — no state, no side effects.
 */

/**
 * Computes the SHA-256 hash of a UTF-8 string and returns a lowercase hex digest.
 *
 * Uses Bun.CryptoHasher for optimal performance on Bun runtime.
 */
export function sha256Hex(data: string): string {
  return new Bun.CryptoHasher("sha256").update(data, "utf-8").digest("hex");
}
