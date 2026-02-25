/**
 * SLSA serializer tests — validates Koi → SLSA v1.0 mapping.
 */

import { describe, expect, test } from "bun:test";
import type { ForgeProvenance } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { mapProvenanceToSlsa } from "./slsa-serializer.js";

describe("mapProvenanceToSlsa", () => {
  test("maps Koi provenance to SLSA v1.0 predicate structure", () => {
    const slsa = mapProvenanceToSlsa(DEFAULT_PROVENANCE);

    expect(slsa.buildDefinition).toBeDefined();
    expect(slsa.runDetails).toBeDefined();
    expect(slsa.buildDefinition.buildType).toBe("koi.forge/tool/v1");
    expect(slsa.runDetails.builder.id).toBe("koi.forge/pipeline/v1");
  });

  test("buildDefinition.buildType matches forge kind", () => {
    const toolProvenance: ForgeProvenance = {
      ...DEFAULT_PROVENANCE,
      buildDefinition: {
        ...DEFAULT_PROVENANCE.buildDefinition,
        buildType: "koi.forge/skill/v1",
      },
    };

    const slsa = mapProvenanceToSlsa(toolProvenance);
    expect(slsa.buildDefinition.buildType).toBe("koi.forge/skill/v1");
  });

  test("runDetails.builder.id matches forge pipeline", () => {
    const slsa = mapProvenanceToSlsa(DEFAULT_PROVENANCE);
    expect(slsa.runDetails.builder.id).toBe("koi.forge/pipeline/v1");
  });

  test("maps timestamps to ISO 8601 strings", () => {
    const slsa = mapProvenanceToSlsa(DEFAULT_PROVENANCE);
    const metadata = slsa.runDetails.metadata;

    expect(metadata).toBeDefined();
    expect(metadata?.startedOn).toBeDefined();
    expect(metadata?.finishedOn).toBeDefined();

    // Validate ISO 8601 format
    const startedDate = new Date(metadata?.startedOn ?? "");
    expect(startedDate.getTime()).toBe(DEFAULT_PROVENANCE.metadata.startedAt);

    const finishedDate = new Date(metadata?.finishedOn ?? "");
    expect(finishedDate.getTime()).toBe(DEFAULT_PROVENANCE.metadata.finishedAt);
  });

  test("preserves external parameters", () => {
    const provenance: ForgeProvenance = {
      ...DEFAULT_PROVENANCE,
      buildDefinition: {
        ...DEFAULT_PROVENANCE.buildDefinition,
        externalParameters: { name: "my-tool", kind: "tool", custom: "value" },
      },
    };

    const slsa = mapProvenanceToSlsa(provenance);
    expect(slsa.buildDefinition.externalParameters.name).toBe("my-tool");
    expect(slsa.buildDefinition.externalParameters.custom).toBe("value");
  });

  test("includes internal parameters when present", () => {
    const provenance: ForgeProvenance = {
      ...DEFAULT_PROVENANCE,
      buildDefinition: {
        ...DEFAULT_PROVENANCE.buildDefinition,
        internalParameters: { sandboxTimeout: 5000 },
      },
    };

    const slsa = mapProvenanceToSlsa(provenance);
    expect(slsa.buildDefinition.internalParameters?.sandboxTimeout).toBe(5000);
  });

  test("omits internal parameters when absent", () => {
    const slsa = mapProvenanceToSlsa(DEFAULT_PROVENANCE);
    expect(slsa.buildDefinition.internalParameters).toBeUndefined();
  });

  test("maps resolved dependencies", () => {
    const provenance: ForgeProvenance = {
      ...DEFAULT_PROVENANCE,
      buildDefinition: {
        ...DEFAULT_PROVENANCE.buildDefinition,
        resolvedDependencies: [
          { uri: "brick://math-utils", digest: { sha256: "abc" }, name: "math-utils" },
          { uri: "brick://string-helpers" },
        ],
      },
    };

    const slsa = mapProvenanceToSlsa(provenance);
    expect(slsa.buildDefinition.resolvedDependencies).toHaveLength(2);
    expect(slsa.buildDefinition.resolvedDependencies?.[0]?.uri).toBe("brick://math-utils");
    expect(slsa.buildDefinition.resolvedDependencies?.[0]?.digest?.sha256).toBe("abc");
    expect(slsa.buildDefinition.resolvedDependencies?.[1]?.uri).toBe("brick://string-helpers");
    expect(slsa.buildDefinition.resolvedDependencies?.[1]?.digest).toBeUndefined();
  });

  test("maps builder version to SLSA format", () => {
    const provenance: ForgeProvenance = {
      ...DEFAULT_PROVENANCE,
      builder: {
        ...DEFAULT_PROVENANCE.builder,
        version: "2.1.0",
      },
    };

    const slsa = mapProvenanceToSlsa(provenance);
    expect(slsa.runDetails.builder.version?.["koi.forge"]).toBe("2.1.0");
  });

  test("invocationId is preserved", () => {
    const slsa = mapProvenanceToSlsa(DEFAULT_PROVENANCE);
    expect(slsa.runDetails.metadata?.invocationId).toBe(DEFAULT_PROVENANCE.metadata.invocationId);
  });
});
