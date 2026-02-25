/**
 * Forge attestation — provenance creation, signing, and verification.
 *
 * Builds ForgeProvenance from pipeline outputs, signs attestations
 * with a pluggable SigningBackend, and verifies attestation integrity.
 */

import type {
  ContentMarker,
  DataClassification,
  ForgeProvenance,
  ForgeRunMetadata,
  ForgeVerificationSummary,
  SigningBackend,
} from "@koi/core";
import type { ForgeConfig } from "./config.js";
import type { ForgeContext, ForgeInput, VerificationReport } from "./types.js";

// ---------------------------------------------------------------------------
// Canonical JSON serialization (sorted keys, deterministic)
// ---------------------------------------------------------------------------

function canonicalJsonSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map(canonicalJsonSerialize);
    return `[${items.join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries = sortedKeys
    .filter((key) => obj[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonSerialize(obj[key])}`);
  return `{${entries.join(",")}}`;
}

// ---------------------------------------------------------------------------
// Map verification report → summary
// ---------------------------------------------------------------------------

function mapVerificationSummary(report: VerificationReport): ForgeVerificationSummary {
  return {
    passed: report.passed,
    finalTrustTier: report.finalTrustTier,
    totalDurationMs: report.totalDurationMs,
    stageResults: report.stages.map((s) => ({
      stage: s.stage,
      passed: s.passed,
      durationMs: s.durationMs,
    })),
  };
}

// ---------------------------------------------------------------------------
// Map forge input → external parameters
// ---------------------------------------------------------------------------

function mapExternalParameters(input: ForgeInput): Readonly<Record<string, unknown>> {
  const { kind, name, description, tags, ...rest } = input;
  return { kind, name, description, tags, ...rest };
}

// ---------------------------------------------------------------------------
// Create provenance
// ---------------------------------------------------------------------------

export interface CreateProvenanceOptions {
  readonly input: ForgeInput;
  readonly context: ForgeContext;
  readonly report: VerificationReport;
  readonly config: ForgeConfig;
  readonly contentHash: string;
  readonly invocationId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly classification?: DataClassification;
  readonly contentMarkers?: readonly ContentMarker[];
}

/**
 * Build a ForgeProvenance struct from forge pipeline outputs.
 */
export function createForgeProvenance(options: CreateProvenanceOptions): ForgeProvenance {
  const {
    input,
    context,
    report,
    contentHash,
    invocationId,
    startedAt,
    finishedAt,
    classification = "public",
    contentMarkers = [],
  } = options;

  const metadata: ForgeRunMetadata = {
    invocationId,
    startedAt,
    finishedAt,
    sessionId: context.sessionId,
    agentId: context.agentId,
    depth: context.depth,
  };

  return {
    source: {
      origin: "forged",
      forgedBy: context.agentId,
      sessionId: context.sessionId,
    },
    buildDefinition: {
      buildType: `koi.forge/${input.kind}/v1`,
      externalParameters: mapExternalParameters(input),
    },
    builder: {
      id: "koi.forge/pipeline/v1",
    },
    metadata,
    verification: mapVerificationSummary(report),
    classification,
    contentMarkers,
    contentHash,
  };
}

// ---------------------------------------------------------------------------
// Sign attestation
// ---------------------------------------------------------------------------

/**
 * Sign a provenance record with a SigningBackend.
 *
 * Returns a new ForgeProvenance with the `attestation` field populated.
 * The signature covers canonical JSON of all fields except `attestation`.
 */
export async function signAttestation(
  provenance: ForgeProvenance,
  signer: SigningBackend,
): Promise<ForgeProvenance> {
  // Serialize provenance without attestation field
  const { attestation: _, ...withoutAttestation } = provenance;
  const canonical = canonicalJsonSerialize(withoutAttestation);
  const data = new TextEncoder().encode(canonical);
  const signatureBytes = await signer.sign(data);
  const signature = Array.from(signatureBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return {
    ...provenance,
    attestation: {
      algorithm: signer.algorithm,
      signature,
    },
  };
}

// ---------------------------------------------------------------------------
// Verify attestation
// ---------------------------------------------------------------------------

/**
 * Verify a provenance record's attestation signature.
 *
 * Re-serializes provenance (without attestation field) to canonical JSON,
 * then verifies the signature with the provided SigningBackend.
 */
export async function verifyAttestation(
  provenance: ForgeProvenance,
  signer: SigningBackend,
): Promise<boolean> {
  if (provenance.attestation === undefined) {
    return false;
  }

  const { attestation, ...withoutAttestation } = provenance;
  const canonical = canonicalJsonSerialize(withoutAttestation);
  const data = new TextEncoder().encode(canonical);

  // Convert hex signature back to bytes
  const signatureHex = attestation.signature;
  const signatureBytes = new Uint8Array(signatureHex.length / 2);
  for (let i = 0; i < signatureHex.length; i += 2) {
    signatureBytes[i / 2] = Number.parseInt(signatureHex.slice(i, i + 2), 16);
  }

  return signer.verify(data, signatureBytes);
}
