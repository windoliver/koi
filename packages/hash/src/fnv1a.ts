/**
 * FNV-1a 32-bit hash — shared utility for L1 and L2 packages.
 *
 * Pure function with zero dependencies.
 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0;
}
