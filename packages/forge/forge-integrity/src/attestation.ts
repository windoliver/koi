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
import type { ForgeConfig, ForgeContext, ForgeInput, VerificationReport } from "@koi/forge-types";

const TEXT_ENCODER = new TextEncoder();

// ---------------------------------------------------------------------------
// Canonical JSON serialization (sorted keys, deterministic)
// ---------------------------------------------------------------------------

export function canonicalJsonSerialize(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  const parts: string[] = [];
  serializeInto(parts, value);
  return parts.join("");
}

function serializeInto(parts: string[], value: unknown): void {
  if (value === null) {
    parts.push("null");
    return;
  }
  if (typeof value !== "object") {
    parts.push(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    parts.push("[");
    for (let i = 0; i < value.length; i++) {
      if (i > 0) parts.push(",");
      serializeInto(parts, value[i]);
    }
    parts.push("]");
    return;
  }
  // Type guard instead of `as` cast
  const obj: Record<string, unknown> =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const sortedKeys = Object.keys(obj).sort();
  parts.push("{");
  let first = true;
  for (const key of sortedKeys) {
    if (obj[key] === undefined) continue;
    if (!first) parts.push(",");
    parts.push(JSON.stringify(key));
    parts.push(":");
    serializeInto(parts, obj[key]);
    first = false;
  }
  parts.push("}");
}

// ---------------------------------------------------------------------------
// Map verification report → summary
// ---------------------------------------------------------------------------

function mapVerificationSummary(report: VerificationReport): ForgeVerificationSummary {
  return {
    passed: report.passed,
    sandbox: report.sandbox,
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
      ...(input.requires?.packages !== undefined && Object.keys(input.requires.packages).length > 0
        ? {
            resolvedDependencies: Object.entries(input.requires.packages).map(
              ([name, version]) => ({
                uri: `npm:${name}@${version}`,
                name,
              }),
            ),
          }
        : {}),
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
  const data = TEXT_ENCODER.encode(canonical);
  const signatureBytes = await signer.sign(data);
  const signature = Buffer.from(signatureBytes).toString("hex");

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
  const data = TEXT_ENCODER.encode(canonical);

  // Convert hex signature back to bytes
  const signatureBytes = new Uint8Array(Buffer.from(attestation.signature, "hex"));

  return signer.verify(data, signatureBytes);
}
