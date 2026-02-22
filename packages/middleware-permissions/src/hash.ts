/**
 * FNV-1a 32-bit hash — duplicated from @koi/engine (L1).
 * L2 packages cannot import from L1. This is 7 lines of well-known math.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0;
}
