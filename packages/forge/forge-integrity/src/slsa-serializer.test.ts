/**
 * Tests for mapProvenanceToSlsa and mapProvenanceToStatement.
 */

import { describe, expect, test } from "bun:test";
import type { ForgeProvenance } from "@koi/core";
import { brickId } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { mapProvenanceToSlsa, mapProvenanceToStatement } from "./slsa-serializer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createProvenance(overrides?: Partial<ForgeProvenance>): ForgeProvenance {
  return { ...DEFAULT_PROVENANCE, ...overrides };
}

// ---------------------------------------------------------------------------
// mapProvenanceToSlsa
// ---------------------------------------------------------------------------

describe("mapProvenanceToSlsa", () => {
  test("maps build definition correctly", () => {
    const provenance = createProvenance({
      buildDefinition: {
        buildType: "koi.forge/tool/v1",
        externalParameters: { kind: "tool", name: "my-tool" },
      },
    });

    const slsa = mapProvenanceToSlsa(provenance);

    expect(slsa.buildDefinition.buildType).toBe("koi.forge/tool/v1");
    expect(slsa.buildDefinition.externalParameters).toEqual({
      kind: "tool",
      name: "my-tool",
    });
    expect(slsa.buildDefinition.resolvedDependencies).toBeUndefined();
    expect(slsa.buildDefinition.internalParameters).toBeUndefined();
  });

  test("maps run details with ISO dates", () => {
    const provenance = createProvenance({
      metadata: {
        invocationId: "inv-test-002",
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_001_000,
        sessionId: "session-1",
        agentId: "agent-1",
        depth: 0,
      },
    });

    const slsa = mapProvenanceToSlsa(provenance);

    expect(slsa.runDetails.builder.id).toBe("koi.forge/pipeline/v1");
    expect(slsa.runDetails.metadata?.invocationId).toBe("inv-test-002");

    // Verify ISO date strings
    const startedOn = slsa.runDetails.metadata?.startedOn;
    const finishedOn = slsa.runDetails.metadata?.finishedOn;
    expect(startedOn).toBe(new Date(1_700_000_000_000).toISOString());
    expect(finishedOn).toBe(new Date(1_700_000_001_000).toISOString());
  });

  test("includes resolved dependencies when present", () => {
    const provenance = createProvenance({
      buildDefinition: {
        buildType: "koi.forge/tool/v1",
        externalParameters: {},
        resolvedDependencies: [
          { uri: "npm:lodash@4.17.21", name: "lodash" },
          { uri: "npm:zod@3.22.0", name: "zod", digest: { sha256: "abc123" } },
        ],
      },
    });

    const slsa = mapProvenanceToSlsa(provenance);

    expect(slsa.buildDefinition.resolvedDependencies).toBeDefined();
    expect(slsa.buildDefinition.resolvedDependencies).toHaveLength(2);

    const lodashDep = slsa.buildDefinition.resolvedDependencies?.[0];
    expect(lodashDep?.uri).toBe("npm:lodash@4.17.21");
    expect(lodashDep?.name).toBe("lodash");
    expect(lodashDep?.digest).toBeUndefined();

    const zodDep = slsa.buildDefinition.resolvedDependencies?.[1];
    expect(zodDep?.uri).toBe("npm:zod@3.22.0");
    expect(zodDep?.name).toBe("zod");
    expect(zodDep?.digest).toEqual({ sha256: "abc123" });
  });

  test("includes builder version when present", () => {
    const provenance = createProvenance({
      builder: { id: "koi.forge/pipeline/v1", version: "1.2.3" },
    });

    const slsa = mapProvenanceToSlsa(provenance);

    expect(slsa.runDetails.builder.version).toEqual({ "koi.forge": "1.2.3" });
  });

  test("omits builder version when absent", () => {
    const provenance = createProvenance({
      builder: { id: "koi.forge/pipeline/v1" },
    });

    const slsa = mapProvenanceToSlsa(provenance);

    expect(slsa.runDetails.builder.version).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapProvenanceToStatement
// ---------------------------------------------------------------------------

describe("mapProvenanceToStatement", () => {
  test("wraps in in-toto v1 envelope", () => {
    const provenance = createProvenance();
    const id = brickId("sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");

    const statement = mapProvenanceToStatement(provenance, id);

    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.predicateType).toBe("https://slsa.dev/provenance/v1");
    expect(statement.predicate).toBeDefined();
    expect(statement.predicate.buildDefinition).toBeDefined();
    expect(statement.predicate.runDetails).toBeDefined();
  });

  test("subject references brickId", () => {
    const id = brickId("sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
    const provenance = createProvenance();

    const statement = mapProvenanceToStatement(provenance, id);

    expect(statement.subject).toHaveLength(1);
    expect(statement.subject[0]?.name).toBe(id);
    expect(statement.subject[0]?.digest).toEqual({
      sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    });
  });

  test("includes Koi extensions", () => {
    const provenance = createProvenance({
      classification: "internal",
      contentMarkers: ["pii"],
      verification: {
        passed: true,
        sandbox: true,
        totalDurationMs: 500,
        stageResults: [{ stage: "static", passed: true, durationMs: 500 }],
      },
    });
    const id = brickId("sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");

    const statement = mapProvenanceToStatement(provenance, id);

    expect(statement.predicate.koi_classification).toBe("internal");
    expect(statement.predicate.koi_contentMarkers).toEqual(["pii"]);
    expect(statement.predicate.koi_verification).toEqual({
      passed: true,
      sandbox: "true",
      totalDurationMs: 500,
    });
  });
});
