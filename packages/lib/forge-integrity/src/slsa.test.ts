import { describe, expect, test } from "bun:test";
import type { ForgeProvenance } from "@koi/core";
import { brickId } from "@koi/core";
import { mapProvenanceToSlsa, mapProvenanceToStatement, SLSA_PROVENANCE_V1_TYPE } from "./slsa.js";

const provenance: ForgeProvenance = {
  source: { origin: "forged", forgedBy: "agent-1", sessionId: "sess-1" },
  buildDefinition: {
    buildType: "https://koi.dev/forge-tools/v1",
    externalParameters: { name: "csv-parser" },
    internalParameters: { policy: "sandboxed" },
    resolvedDependencies: [{ uri: "pkg:bun/zod@4.3.6", digest: { sha256: "abc" } }],
  },
  builder: { id: "koi/forge-tools", version: "1.0.0", nodeId: "node-a" },
  metadata: {
    invocationId: "inv-1",
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_500,
    sessionId: "sess-1",
    agentId: "agent-1",
    depth: 0,
  },
  verification: {
    passed: true,
    sandbox: true,
    totalDurationMs: 1500,
    stageResults: [{ stage: "static", passed: true, durationMs: 25 }],
  },
  classification: "internal",
  contentMarkers: ["pii"],
  contentHash: "sha256:cafebabe000000000000000000000000000000000000000000000000000000ff",
};

describe("SLSA provenance mapping", () => {
  test("maps ForgeProvenance to a SLSA v1.0 predicate with Koi extensions", () => {
    const slsa = mapProvenanceToSlsa(provenance);

    expect(slsa.buildDefinition.buildType).toBe("https://koi.dev/forge-tools/v1");
    expect(slsa.buildDefinition.externalParameters).toEqual({ name: "csv-parser" });
    expect(slsa.runDetails.builder.id).toBe("koi/forge-tools");
    expect(slsa.runDetails.metadata.invocationId).toBe("inv-1");
    expect(slsa.runDetails.metadata.startedOn).toBe("2023-11-14T22:13:20.000Z");
    expect(slsa.runDetails.metadata.finishedOn).toBe("2023-11-14T22:13:21.500Z");
    expect(slsa.koiVerification.passed).toBe(true);
    expect(slsa.koiClassification).toBe("internal");
    expect(slsa.koiContentMarkers).toEqual(["pii"]);
  });

  test("wraps the SLSA predicate in an in-toto Statement v1", () => {
    const statement = mapProvenanceToStatement(
      provenance,
      brickId("sha256:cafebabe000000000000000000000000000000000000000000000000000000ff"),
    );

    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.predicateType).toBe(SLSA_PROVENANCE_V1_TYPE);
    expect(statement.subject).toEqual([
      {
        name: "koi-brick",
        digest: {
          sha256: "cafebabe000000000000000000000000000000000000000000000000000000ff",
        },
      },
    ]);
    expect(statement.predicate.runDetails.builder.id).toBe("koi/forge-tools");
  });
});
