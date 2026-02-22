/**
 * SHA-256 content hash utility using Web Crypto API (built into Bun).
 */

import type { ContentHash } from "./types.js";
import { contentHash } from "./types.js";

/** Compute SHA-256 hash of the given content string. */
export async function computeContentHash(content: string): Promise<ContentHash> {
  const data = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  const hex = Array.from(hashArray, (b) => b.toString(16).padStart(2, "0")).join("");
  return contentHash(hex);
}
