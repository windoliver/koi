import type {
  BrickId,
  ForgeBuildDefinition,
  ForgeBuilder,
  ForgeProvenance,
  ForgeVerificationSummary,
  InTotoStatementV1,
} from "@koi/core";

export const SLSA_PROVENANCE_V1_TYPE = "https://slsa.dev/provenance/v1" as const;

export interface SlsaProvenanceV1 {
  readonly buildDefinition: ForgeBuildDefinition;
  readonly runDetails: {
    readonly builder: ForgeBuilder;
    readonly metadata: {
      readonly invocationId: string;
      readonly startedOn: string;
      readonly finishedOn: string;
    };
  };
  readonly koiVerification: ForgeVerificationSummary;
  readonly koiClassification: ForgeProvenance["classification"];
  readonly koiContentMarkers: ForgeProvenance["contentMarkers"];
  readonly koiSource: ForgeProvenance["source"];
  readonly koiContentHash: string;
}

export function mapProvenanceToSlsa(provenance: ForgeProvenance): SlsaProvenanceV1 {
  return {
    buildDefinition: provenance.buildDefinition,
    runDetails: {
      builder: provenance.builder,
      metadata: {
        invocationId: provenance.metadata.invocationId,
        startedOn: new Date(provenance.metadata.startedAt).toISOString(),
        finishedOn: new Date(provenance.metadata.finishedAt).toISOString(),
      },
    },
    koiVerification: provenance.verification,
    koiClassification: provenance.classification,
    koiContentMarkers: provenance.contentMarkers,
    koiSource: provenance.source,
    koiContentHash: provenance.contentHash,
  };
}

function subjectDigest(brickId: BrickId): Readonly<Record<string, string>> {
  const [algorithm, digest] = brickId.split(":");
  return { [algorithm ?? "sha256"]: digest ?? brickId };
}

export function mapProvenanceToStatement(
  provenance: ForgeProvenance,
  brickId: BrickId,
): InTotoStatementV1<SlsaProvenanceV1> {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "koi-brick", digest: subjectDigest(brickId) }],
    predicateType: SLSA_PROVENANCE_V1_TYPE,
    predicate: mapProvenanceToSlsa(provenance),
  };
}
