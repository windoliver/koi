import { describe, expect, test } from "bun:test";
import type { BrickId, ForgeVerificationSummary } from "@koi/core";
import { brickId } from "@koi/core";
import { createForgeProvenance } from "./provenance.js";

const passingVerification: ForgeVerificationSummary = {
  passed: true,
  sandbox: true,
  totalDurationMs: 1500,
  stageResults: [{ stage: "static", passed: true, durationMs: 12 }],
};

const draftVerification: ForgeVerificationSummary = {
  passed: false,
  sandbox: false,
  totalDurationMs: 0,
  stageResults: [],
};

import type { CreateProvenanceOptions } from "./provenance.js";

const baseOptions: CreateProvenanceOptions = {
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
  verification: passingVerification,
  classification: "internal",
  contentMarkers: [],
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

  test("uses caller-supplied verification + classification — no defaults invented", () => {
    const prov = createForgeProvenance(baseOptions);
    expect(prov.verification).toEqual(passingVerification);
    expect(prov.verification.passed).toBe(true);
    expect(prov.verification.sandbox).toBe(true);
    expect(prov.classification).toBe("internal");
    expect(prov.contentMarkers).toEqual([]);
    expect(prov.parentBrickId).toBeUndefined();
  });

  test("propagates secret classification + markers verbatim", () => {
    const prov = createForgeProvenance({
      ...baseOptions,
      classification: "secret",
      contentMarkers: ["credentials", "pii"],
    });
    expect(prov.classification).toBe("secret");
    expect(prov.contentMarkers).toEqual(["credentials", "pii"]);
  });

  test("preserves draft verification (passed=false, sandbox=false) faithfully", () => {
    const prov = createForgeProvenance({ ...baseOptions, verification: draftVerification });
    expect(prov.verification.passed).toBe(false);
    expect(prov.verification.sandbox).toBe(false);
    expect(prov.verification).toEqual(draftVerification);
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

  test("freezes verification so post-construction mutation throws in strict mode", () => {
    const mutable: ForgeVerificationSummary = {
      passed: false,
      sandbox: false,
      totalDurationMs: 0,
      stageResults: [],
    };
    const prov = createForgeProvenance({ ...baseOptions, verification: mutable });
    expect(Object.isFrozen(prov.verification)).toBe(true);
    expect(Object.isFrozen(prov)).toBe(true);
    // Mutating the original input must not leak into the stored verification.
    Object.assign(mutable, { passed: true, sandbox: true });
    expect(prov.verification.passed).toBe(false);
    expect(prov.verification.sandbox).toBe(false);
  });

  test("rejects parentBrickId without evolutionKind (and vice versa)", () => {
    const parent = brickId(`sha256:${"a".repeat(64)}`);
    expect(() => createForgeProvenance({ ...baseOptions, parentBrickId: parent })).toThrow(
      /both set or both omitted/,
    );
    expect(() => createForgeProvenance({ ...baseOptions, evolutionKind: "fix" })).toThrow(
      /both set or both omitted/,
    );
  });

  test("does not stack-overflow on cyclic externalParameters or verification", () => {
    type Cyclic = { self?: Cyclic; name: string };
    const cyclic: Cyclic = { name: "csv" };
    cyclic.self = cyclic;
    // structuredClone preserves cycles; deepFreeze must not recurse into them.
    const prov = createForgeProvenance({
      ...baseOptions,
      externalParameters: cyclic as unknown as Readonly<Record<string, unknown>>,
    });
    expect(Object.isFrozen(prov.buildDefinition.externalParameters)).toBe(true);
  });

  test("rejects Map/Set/Date in externalParameters (would survive Object.freeze)", () => {
    expect(() =>
      createForgeProvenance({
        ...baseOptions,
        externalParameters: { schedule: new Date(0) } as unknown as Readonly<
          Record<string, unknown>
        >,
      }),
    ).toThrow(/JSON-plain/);
    expect(() =>
      createForgeProvenance({
        ...baseOptions,
        externalParameters: { tags: new Set(["a"]) } as unknown as Readonly<
          Record<string, unknown>
        >,
      }),
    ).toThrow(/JSON-plain/);
    expect(() =>
      createForgeProvenance({
        ...baseOptions,
        externalParameters: { lookup: new Map([["k", "v"]]) } as unknown as Readonly<
          Record<string, unknown>
        >,
      }),
    ).toThrow(/JSON-plain/);
  });

  test("rejects invalid classification values at runtime", () => {
    expect(() =>
      createForgeProvenance({
        ...baseOptions,
        classification: "topsecret" as unknown as "secret",
      }),
    ).toThrow(/classification/);
  });

  test("rejects unknown contentMarker values at runtime", () => {
    expect(() =>
      createForgeProvenance({
        ...baseOptions,
        contentMarkers: ["badmarker"] as unknown as readonly never[],
      }),
    ).toThrow(/contentMarker/);
  });

  test("rejects malformed verification (missing booleans, non-finite duration)", () => {
    expect(() =>
      createForgeProvenance({
        ...baseOptions,
        verification: { passed: "yes" } as unknown as typeof passingVerification,
      }),
    ).toThrow(/passed/);
    expect(() =>
      createForgeProvenance({
        ...baseOptions,
        verification: {
          passed: true,
          sandbox: true,
          totalDurationMs: Number.NaN,
          stageResults: [],
        },
      }),
    ).toThrow(/totalDurationMs/);
  });

  test("rejects empty/missing scalar fields (builderId, contentHash, sessionId, etc.)", () => {
    expect(() => createForgeProvenance({ ...baseOptions, builderId: "" })).toThrow(/builderId/);
    expect(() => createForgeProvenance({ ...baseOptions, contentHash: "" })).toThrow(/contentHash/);
    expect(() => createForgeProvenance({ ...baseOptions, sessionId: "" })).toThrow(/sessionId/);
    expect(() => createForgeProvenance({ ...baseOptions, agentId: "" })).toThrow(/agentId/);
    expect(() => createForgeProvenance({ ...baseOptions, invocationId: "" })).toThrow(
      /invocationId/,
    );
    expect(() => createForgeProvenance({ ...baseOptions, forgedBy: "" })).toThrow(/forgedBy/);
    expect(() => createForgeProvenance({ ...baseOptions, buildType: "" })).toThrow(/buildType/);
  });

  test("rejects negative or non-finite depth", () => {
    expect(() => createForgeProvenance({ ...baseOptions, depth: -1 })).toThrow(/depth/);
    expect(() => createForgeProvenance({ ...baseOptions, depth: Number.NaN })).toThrow(/depth/);
  });

  test("rejects empty parentBrickId or invalid evolutionKind", () => {
    expect(() =>
      createForgeProvenance({
        ...baseOptions,
        parentBrickId: "" as unknown as BrickId,
        evolutionKind: "fix",
      }),
    ).toThrow(/parentBrickId/);
    expect(() =>
      createForgeProvenance({
        ...baseOptions,
        parentBrickId: brickId(`sha256:${"a".repeat(64)}`),
        evolutionKind: "bogus" as unknown as "fix",
      }),
    ).toThrow(/evolutionKind/);
  });

  test("rejects deeply-nested externalParameters with a typed error (no stack overflow)", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 100; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(() =>
      createForgeProvenance({
        ...baseOptions,
        externalParameters: deep as Readonly<Record<string, unknown>>,
      }),
    ).toThrow(/depth/);
  });

  test("rejects malformed stage digests", () => {
    expect(() =>
      createForgeProvenance({
        ...baseOptions,
        verification: {
          passed: true,
          sandbox: true,
          totalDurationMs: 1,
          stageResults: [{ stage: "", passed: true, durationMs: 1 }],
        },
      }),
    ).toThrow(/stage/);
  });

  test("rejects function values inside externalParameters", () => {
    expect(() =>
      createForgeProvenance({
        ...baseOptions,
        externalParameters: { hook: () => 1 } as unknown as Readonly<Record<string, unknown>>,
      }),
    ).toThrow(/JSON-plain/);
  });

  test("freezes externalParameters and contentMarkers against post-construction mutation", () => {
    const externals = { name: "csv-parse", schemaVer: 1 };
    const markers = ["pii"] as const;
    const prov = createForgeProvenance({
      ...baseOptions,
      externalParameters: externals,
      contentMarkers: markers,
    });
    expect(Object.isFrozen(prov.buildDefinition.externalParameters)).toBe(true);
    expect(Object.isFrozen(prov.contentMarkers)).toBe(true);
    // Original input mutation does not leak.
    (externals as Record<string, unknown>).name = "evil";
    expect(prov.buildDefinition.externalParameters).toEqual({ name: "csv-parse", schemaVer: 1 });
  });
});
