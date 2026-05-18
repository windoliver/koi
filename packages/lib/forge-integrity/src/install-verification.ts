import type { BrickArtifact, SigningBackend } from "@koi/core";
import type { AttestationVerificationResult, VerifyAttestationOptions } from "./attestation.js";
import { verifyAttestation } from "./attestation.js";
import type { BrickVerifier, IntegrityResult } from "./integrity.js";

export interface VerifyInstallProvenanceOptions {
  readonly expectedBuilderId: string;
  readonly verifier: BrickVerifier;
  readonly signer: SigningBackend;
  readonly attestation?: VerifyAttestationOptions | undefined;
}

export type InstallProvenanceResult =
  | { readonly kind: "ok"; readonly ok: true }
  | { readonly kind: "integrity_failed"; readonly ok: false; readonly integrity: IntegrityResult }
  | {
      readonly kind: "attestation_failed";
      readonly ok: false;
      readonly attestation: AttestationVerificationResult;
    };

export async function verifyInstallProvenance(
  brick: BrickArtifact,
  options: VerifyInstallProvenanceOptions,
): Promise<InstallProvenanceResult> {
  const integrity = options.verifier(brick, options.expectedBuilderId);
  if (!integrity.ok) return { kind: "integrity_failed", ok: false, integrity };
  const attestation = await verifyAttestation(
    brick.provenance,
    options.signer,
    options.attestation,
  );
  if (!attestation.ok) return { kind: "attestation_failed", ok: false, attestation };
  return { kind: "ok", ok: true };
}
