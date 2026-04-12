/**
 * Hash chain + Ed25519 signing for tamper-evident audit entries.
 *
 * Two-layer tamper evidence:
 * 1. Hash chain (prev_hash): detects insertion, deletion, reordering — O(1) per entry
 * 2. Ed25519 signature: non-repudiation — cryptographic proof of authorship
 */

import type { KeyObject } from "node:crypto";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import type { AuditEntry } from "@koi/core";

/** SHA-256 hex of the genesis entry's "previous" — 64 zero chars. */
export const GENESIS_HASH: string = "0".repeat(64);

export interface SigningHandle {
  /** Sign and hash-chain an entry. Returns the entry with prev_hash + signature added. */
  readonly stamp: (entry: AuditEntry) => AuditEntry;
  /** DER-encoded SPKI public key (for verifiers). */
  readonly publicKeyDer: Buffer;
  /**
   * Signal that one or more entries will be dropped (queue overflow).
   * The next stamp() call will use GENESIS_HASH for prev_hash so verifiers
   * see an explicit chain restart — making the gap visible rather than hidden.
   */
  readonly markGap: () => void;
}

function buildStamper(privateKey: KeyObject): {
  stamp: (entry: AuditEntry) => AuditEntry;
  markGap: () => void;
} {
  // let justified: mutable chain state — updated after each stamped entry
  let lastEntryJson: string | null = null;
  // let justified: set by markGap() when an entry will be dropped due to overflow
  let gapped = false;

  function stamp(entry: AuditEntry): AuditEntry {
    // On a gap, reset to GENESIS_HASH so the chain restart is visible to verifiers.
    // Entries before the gap had B.prev_hash = hash(dropped-A), which will fail
    // chain verification and also signal data loss.
    const prevHash =
      lastEntryJson === null || gapped
        ? GENESIS_HASH
        : createHash("sha256").update(lastEntryJson).digest("hex");

    gapped = false;

    const entryWithChain: AuditEntry = { ...entry, prev_hash: prevHash };

    // Sign the full entry-with-chain (but without the signature field itself)
    const payload = new TextEncoder().encode(JSON.stringify(entryWithChain));
    const sigBuffer = sign(null, payload, privateKey);
    const signature = sigBuffer.toString("base64url");

    const signedEntry: AuditEntry = { ...entryWithChain, signature };
    lastEntryJson = JSON.stringify(signedEntry);

    return signedEntry;
  }

  return {
    stamp,
    markGap: () => {
      gapped = true;
    },
  };
}

/**
 * Create a signing handle from an externally provided Ed25519 private key.
 */
export function createSigningHandle(privateKey: KeyObject, publicKey: KeyObject): SigningHandle {
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const { stamp, markGap } = buildStamper(privateKey);
  return { stamp, markGap, publicKeyDer };
}

/**
 * Generate an ephemeral Ed25519 keypair and return a signing handle.
 * The keypair is discarded when the middleware is garbage-collected.
 */
export function createEphemeralSigningHandle(): SigningHandle {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const { stamp, markGap } = buildStamper(privateKey);
  return { stamp, markGap, publicKeyDer };
}

/**
 * Verify an Ed25519 signature on an audit entry.
 * The signature covers the entry JSON with the `signature` field omitted.
 */
export function verifyEntrySignature(entry: AuditEntry, publicKeyDer: Buffer): boolean {
  if (entry.signature === undefined || entry.prev_hash === undefined) return false;

  // Build the signed payload: entry without the signature field
  const { signature: sig, ...entryWithoutSig } = entry as AuditEntry & {
    readonly signature: string;
  };

  const payload = new TextEncoder().encode(JSON.stringify(entryWithoutSig));
  const sigBuffer = new Uint8Array(Buffer.from(sig, "base64url"));

  try {
    return verify(null, payload, { key: publicKeyDer, format: "der", type: "spki" }, sigBuffer);
  } catch {
    return false;
  }
}
