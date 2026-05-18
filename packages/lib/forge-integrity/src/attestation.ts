import { Buffer } from "node:buffer";
import type { ForgeProvenance, SigningBackend } from "@koi/core";
import { canonicalBytes } from "./canonical-json.js";

export interface SignAttestationOptions {
  readonly keyId?: string | undefined;
}

export interface VerifyAttestationOptions {
  readonly now?: number | undefined;
  readonly maxAgeMs?: number | undefined;
}

export interface AttestationOk {
  readonly kind: "ok";
  readonly ok: true;
  readonly algorithm: string;
  readonly keyId?: string | undefined;
}

export interface AttestationMissing {
  readonly kind: "missing_attestation";
  readonly ok: false;
}

export interface AttestationInvalid {
  readonly kind: "signature_invalid";
  readonly ok: false;
  readonly algorithm: string;
}

export interface AttestationExpired {
  readonly kind: "expired";
  readonly ok: false;
  readonly finishedAt: number;
  readonly now: number;
  readonly maxAgeMs: number;
}

export interface AttestationMalformed {
  readonly kind: "malformed";
  readonly ok: false;
  readonly reason: string;
}

export type AttestationVerificationResult =
  | AttestationOk
  | AttestationMissing
  | AttestationInvalid
  | AttestationExpired
  | AttestationMalformed;

function unsignedProvenance(provenance: ForgeProvenance): Omit<ForgeProvenance, "attestation"> {
  const { attestation: _attestation, ...unsigned } = provenance;
  return unsigned;
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return undefined;
  }
  try {
    return new Uint8Array(Buffer.from(value, "base64"));
  } catch {
    return undefined;
  }
}

export async function signAttestation(
  provenance: ForgeProvenance,
  signer: SigningBackend,
  options: SignAttestationOptions = {},
): Promise<ForgeProvenance> {
  const signature = await signer.sign(canonicalBytes(unsignedProvenance(provenance)));
  return Object.freeze({
    ...unsignedProvenance(provenance),
    attestation: Object.freeze({
      algorithm: signer.algorithm,
      signature: encodeBase64(signature),
      ...(options.keyId !== undefined ? { keyId: options.keyId } : {}),
    }),
  });
}

export async function verifyAttestation(
  provenance: ForgeProvenance,
  signer: SigningBackend,
  options: VerifyAttestationOptions = {},
): Promise<AttestationVerificationResult> {
  const attestation = provenance.attestation;
  if (attestation === undefined) return { kind: "missing_attestation", ok: false };
  if (attestation.algorithm !== signer.algorithm) {
    return { kind: "signature_invalid", ok: false, algorithm: attestation.algorithm };
  }
  const signature = decodeBase64(attestation.signature);
  if (signature === undefined || signature.length === 0) {
    return { kind: "malformed", ok: false, reason: "attestation.signature is not base64" };
  }
  if (options.maxAgeMs !== undefined) {
    const now = options.now ?? Date.now();
    const age = now - provenance.metadata.finishedAt;
    if (age > options.maxAgeMs) {
      return {
        kind: "expired",
        ok: false,
        finishedAt: provenance.metadata.finishedAt,
        now,
        maxAgeMs: options.maxAgeMs,
      };
    }
  }
  const valid = await signer.verify(canonicalBytes(unsignedProvenance(provenance)), signature);
  if (!valid) return { kind: "signature_invalid", ok: false, algorithm: attestation.algorithm };
  return {
    kind: "ok",
    ok: true,
    algorithm: attestation.algorithm,
    ...(attestation.keyId !== undefined ? { keyId: attestation.keyId } : {}),
  };
}
