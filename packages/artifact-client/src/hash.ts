/**
 * SHA-256 content hash utility using Bun.CryptoHasher (sync, via @koi/hash).
 */

import { computeContentHash as computeSha256 } from "@koi/hash";
import type { ContentHash } from "./types.js";
import { contentHash } from "./types.js";

/** Compute SHA-256 hash of the given content string. */
export function computeContentHash(content: string): ContentHash {
  return contentHash(computeSha256(content));
}
