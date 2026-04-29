import { describe, expect, test } from "bun:test";
import { brickId } from "@koi/core";
import { createForgeProvenance } from "./provenance.js";

const baseOptions = {
  forgedBy: "agent-7",
  sessionId: "sess-x",
  agentId: "agent-7",
  invocationId: "inv-42",
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_001_500,
  contentHash: "sha256:cafebabe",
  buildType: "koi.forge.tool/v1",
  externalParameters: { name: "csv-parse" },
  builderId: "koi/forge/pipeline/v1",
};

describe("createForgeProvenance", () => {
  test("records creator, timestamps, and demand on the provenance struct", () => {
    const prov = createForgeProvenance({ ...baseOptions, demandId: "dem-9" });

    expect(prov.source.origin).toBe("forged");
    if (prov.source.origin === "forged") {
      expect(prov.source.forgedBy).toBe("agent-7");
    }
    expect(prov.metadata.startedAt).toBe(baseOptions.startedAt);
    expect(prov.metadata.finishedAt).toBe(baseOptions.finishedAt);
    expect(prov.metadata.invocationId).toBe("inv-42");
    expect(prov.buildDefinition.externalParameters).toEqual({
      name: "csv-parse",
      demandId: "dem-9",
    });
    expect(prov.contentHash).toBe("sha256:cafebabe");
  });

  test("derives totalDurationMs from start/finish and defaults classification", () => {
    const prov = createForgeProvenance(baseOptions);
    expect(prov.verification.totalDurationMs).toBe(1500);
    expect(prov.classification).toBe("public");
    expect(prov.contentMarkers).toEqual([]);
    expect(prov.parentBrickId).toBeUndefined();
  });

  test("includes parentBrickId + evolutionKind when supplied", () => {
    const parent = brickId(`sha256:${"a".repeat(64)}`);
    const prov = createForgeProvenance({
      ...baseOptions,
      parentBrickId: parent,
      evolutionKind: "fix",
    });
    expect(prov.parentBrickId).toBe(parent);
    expect(prov.evolutionKind).toBe("fix");
  });

  test("rejects finishedAt before startedAt", () => {
    expect(() =>
      createForgeProvenance({ ...baseOptions, startedAt: 100, finishedAt: 50 }),
    ).toThrow();
  });
});
