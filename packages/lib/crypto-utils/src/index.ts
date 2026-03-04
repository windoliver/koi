/**
 * @koi/crypto-utils — Shared cryptographic primitives for L2 packages.
 *
 * Layer: L0u (utility, depends on nothing, importable by L1 and L2).
 *
 * Exports:
 * - Ed25519 key generation, signing, and verification (Web Crypto API)
 * - SHA-256 hashing (Bun.CryptoHasher)
 */

export { canonicalize, sortKeys } from "./canonicalize.js";
export type { Ed25519KeyPair } from "./ed25519.js";
export { generateEd25519KeyPair, signEd25519, verifyEd25519 } from "./ed25519.js";
export { sha256Hex } from "./sha256.js";
