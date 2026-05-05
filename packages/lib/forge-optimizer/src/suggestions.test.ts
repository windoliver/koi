import { describe, expect, test } from "bun:test";
import type { BrickArtifact, BrickArtifactBase, CompositeArtifact, ToolArtifact } from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { suggestMerge, suggestSimplify } from "./suggestions.js";

const baseFields: Omit<BrickArtifactBase, "kind" | "name" | "description" | "id"> = {
  scope: "agent",
  origin: "operator",
  policy: DEFAULT_UNSANDBOXED_POLICY,
  lifecycle: "active",
  provenance: {} as BrickArtifactBase["provenance"],
  version: "1.0.0",
  tags: [],
  usageCount: 0,
};

function tool(id: string, name: string, description: string): ToolArtifact {
  return {
    ...baseFields,
    id: `sha256:${id}` as ToolArtifact["id"],
    kind: "tool",
    name,
    description,
    implementation: "",
    inputSchema: {},
  };
}

function composite(id: string, steps: number): CompositeArtifact {
  const port = { name: "p", schema: {} };
  return {
    ...baseFields,
    id: `sha256:${id}` as CompositeArtifact["id"],
    kind: "composite",
    name: `comp-${id}`,
    description: "",
    steps: Array.from({ length: steps }, (_, i) => ({
      brickId: `sha256:step${String(i)}` as ToolArtifact["id"],
      inputPort: port,
      outputPort: port,
    })),
    exposedInput: port,
    exposedOutput: port,
    outputKind: "tool",
  };
}

describe("suggestMerge", () => {
  test("returns no suggestions for unique bricks", () => {
    const bricks: readonly BrickArtifact[] = [
      tool("a", "fetch", "Fetches data"),
      tool("b", "parse", "Parses data"),
    ];
    expect(suggestMerge(bricks).suggestions).toEqual([]);
  });

  test("groups duplicates by normalized name + description + kind", () => {
    const bricks: readonly BrickArtifact[] = [
      tool("a", "Fetch URL", "Fetches a URL"),
      tool("b", "  fetch   url  ", "fetches a url"),
    ];
    const r = suggestMerge(bricks);
    expect(r.suggestions.length).toBe(1);
    expect(r.suggestions[0]?.kind).toBe("merge");
    expect(r.suggestions[0]?.brickIds.length).toBe(2);
  });

  test("does not group across different kinds", () => {
    const port = { name: "p", schema: {} };
    const tool1 = tool("a", "x", "y");
    const tool2 = tool("b", "x", "y");
    const compArt: CompositeArtifact = {
      ...baseFields,
      id: "sha256:c" as CompositeArtifact["id"],
      kind: "composite",
      name: "x",
      description: "y",
      steps: [],
      exposedInput: port,
      exposedOutput: port,
      outputKind: "tool",
    };
    const r = suggestMerge([tool1, tool2, compArt]);
    expect(r.suggestions.length).toBe(1);
    expect(r.suggestions[0]?.brickIds).toEqual([tool1.id, tool2.id]);
  });

  test("returns suggestion id stable from grouped key", () => {
    const r = suggestMerge([tool("a", "fetch", "x"), tool("b", "fetch", "x")]);
    expect(r.suggestions[0]?.reason).toContain("fetch");
  });

  test("does not merge across different scopes (trust boundary)", () => {
    const a = tool("a", "fetch", "x");
    const b: ToolArtifact = { ...tool("b", "fetch", "x"), scope: "global" };
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });

  test("does not merge across different lifecycles (e.g. quarantined vs active)", () => {
    const a = tool("a", "fetch", "x");
    const b: ToolArtifact = { ...tool("b", "fetch", "x"), lifecycle: "quarantined" };
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });

  test("does not merge across different origins", () => {
    const a = tool("a", "fetch", "x");
    const b: ToolArtifact = { ...tool("b", "fetch", "x"), origin: "forged" };
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });

  test("does not merge across different ToolPolicy (sandbox vs unsandboxed widens privilege)", () => {
    const a = tool("a", "fetch", "x");
    const b: ToolArtifact = {
      ...tool("b", "fetch", "x"),
      policy: { ...DEFAULT_UNSANDBOXED_POLICY, sandbox: true },
    };
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });

  test("does not merge across different `requires` (network/bin/credential needs differ)", () => {
    const a: ToolArtifact = { ...tool("a", "fetch", "x"), requires: {} };
    const b: ToolArtifact = { ...tool("b", "fetch", "x"), requires: { bins: ["git"] } };
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });

  test("does not merge tools with different `implementation` (same labels, different behavior)", () => {
    const a: ToolArtifact = { ...tool("a", "fetch", "x"), implementation: "function v1() {}" };
    const b: ToolArtifact = { ...tool("b", "fetch", "x"), implementation: "function v2() {}" };
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });

  test("does not merge tools with different `inputSchema`", () => {
    const a: ToolArtifact = { ...tool("a", "fetch", "x"), inputSchema: { type: "string" } };
    const b: ToolArtifact = { ...tool("b", "fetch", "x"), inputSchema: { type: "object" } };
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });

  test("groups skills/agents/middleware/composites only when kind-contract matches", () => {
    const skillA: BrickArtifact = {
      ...baseFields,
      id: "sha256:s1" as ToolArtifact["id"],
      kind: "skill",
      name: "x",
      description: "",
      content: "STEP A",
    };
    const skillB: BrickArtifact = { ...skillA, id: "sha256:s2" as ToolArtifact["id"] };
    const skillC: BrickArtifact = {
      ...skillA,
      id: "sha256:s3" as ToolArtifact["id"],
      content: "STEP B",
    };
    const agentA: BrickArtifact = {
      ...baseFields,
      id: "sha256:a1" as ToolArtifact["id"],
      kind: "agent",
      name: "y",
      description: "",
      manifestYaml: "agent: A",
    };
    const agentB: BrickArtifact = {
      ...agentA,
      id: "sha256:a2" as ToolArtifact["id"],
      manifestYaml: "agent: B",
    };
    const mwA: BrickArtifact = {
      ...baseFields,
      id: "sha256:m1" as ToolArtifact["id"],
      kind: "middleware",
      name: "z",
      description: "",
      implementation: "f1",
    };
    const mwB: BrickArtifact = {
      ...mwA,
      id: "sha256:m2" as ToolArtifact["id"],
      implementation: "f2",
    };
    const compA = composite("c1", 1);
    const compB: CompositeArtifact = { ...compA, id: "sha256:c2" as CompositeArtifact["id"] };
    const r = suggestMerge([skillA, skillB, skillC, agentA, agentB, mwA, mwB, compA, compB]);
    // Only skillA+skillB and compA+compB share full kindContract.
    const groupSizes = r.suggestions.map((s) => s.brickIds.length).sort();
    expect(groupSizes).toEqual([2, 2]);
  });

  test("does not merge across different trust tiers (verified vs local)", () => {
    const a: ToolArtifact = { ...tool("a", "fetch", "x"), trustTier: "local" };
    const b: ToolArtifact = { ...tool("b", "fetch", "x"), trustTier: "verified" };
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });

  test("does not collide bricks where a space straddles name/description boundary", () => {
    // Without per-field encoding, "a b" + "c" === "a" + "b c" via space-join.
    const a = tool("a", "x y", "z");
    const b = tool("b", "x", "y z");
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });

  test("does not merge across different versions (rollback target preserved)", () => {
    const a: ToolArtifact = { ...tool("a", "fetch", "x"), version: "1.0.0" };
    const b: ToolArtifact = { ...tool("b", "fetch", "x"), version: "2.0.0" };
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });

  test("does not merge across different provenance (audit lineage preserved)", () => {
    const a: ToolArtifact = {
      ...tool("a", "fetch", "x"),
      provenance: { source: "primary" } as unknown as ToolArtifact["provenance"],
    };
    const b: ToolArtifact = {
      ...tool("b", "fetch", "x"),
      provenance: { source: "fork" } as unknown as ToolArtifact["provenance"],
    };
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });

  test("does not merge across different namespaces", () => {
    const a: ToolArtifact = { ...tool("a", "fetch", "x"), namespace: "@acme/x" };
    const b: ToolArtifact = { ...tool("b", "fetch", "x"), namespace: "@other/x" };
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });

  test("does not merge bricks with different trigger patterns (distinct activation paths)", () => {
    const a: ToolArtifact = { ...tool("a", "fetch", "x"), trigger: ["search-query"] };
    const b: ToolArtifact = { ...tool("b", "fetch", "x"), trigger: ["api-call"] };
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });

  test("does merge bricks whose trigger lists differ only in order", () => {
    const a: ToolArtifact = { ...tool("a", "fetch", "x"), trigger: ["one", "two"] };
    const b: ToolArtifact = { ...tool("b", "fetch", "x"), trigger: ["two", "one"] };
    expect(suggestMerge([a, b]).suggestions).toHaveLength(1);
  });

  test("does not merge bricks with different companion files (required assets diverge)", () => {
    const a: ToolArtifact = { ...tool("a", "fetch", "x"), files: { "schema.json": "{}" } };
    const b: ToolArtifact = { ...tool("b", "fetch", "x"), files: { "schema.json": '{"v":2}' } };
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });

  test("does not merge bricks with different configSchemas (instantiation contracts diverge)", () => {
    const a: ToolArtifact = { ...tool("a", "fetch", "x"), configSchema: { type: "object" } };
    const b: ToolArtifact = {
      ...tool("b", "fetch", "x"),
      configSchema: { type: "object", required: ["host"] },
    };
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });

  test("isolates non-JSON-safe bricks (cyclic schema does not abort the whole sweep)", () => {
    // Pre-fix bug: `groupKey` calls `JSON.stringify`; a single cyclic
    // artifact threw out of the loop and dropped every other brick's
    // merge advice on the floor. Now: the bad brick is skipped and the
    // remaining bricks still get suggestions.
    const cyclicSchema: Record<string, unknown> = {};
    cyclicSchema.self = cyclicSchema;
    const bad: ToolArtifact = { ...tool("bad", "fetch", "x"), inputSchema: cyclicSchema };
    const a = tool("a", "parse", "y");
    const b = tool("b", "parse", "y");
    const r = suggestMerge([bad, a, b]);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]?.brickIds).toEqual([a.id, b.id]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]?.brickId).toBe(bad.id);
    expect(r.skipped[0]?.reason).toContain("serialization");
  });

  test("does not merge bricks with different driftContext (source lineage diverges)", () => {
    const a: ToolArtifact = {
      ...tool("a", "fetch", "x"),
      driftContext: { sourcePath: "/a.ts" } as unknown as ToolArtifact["driftContext"],
    };
    const b: ToolArtifact = {
      ...tool("b", "fetch", "x"),
      driftContext: { sourcePath: "/b.ts" } as unknown as ToolArtifact["driftContext"],
    };
    expect(suggestMerge([a, b]).suggestions).toEqual([]);
  });
});

describe("suggestSimplify", () => {
  test("returns undefined for non-composite", () => {
    expect(suggestSimplify(tool("a", "x", "y"))).toBeUndefined();
  });

  test("does not throw on cyclic / non-JSON-safe port schema", () => {
    // Pre-fix bug: encodePort JSON-stringified the schema; a single
    // composite with a cyclic port schema threw out of suggestSimplify
    // and aborted the whole simplify analysis pass.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const port = { name: "p", schema: cyclic };
    const stepPort = { name: "p", schema: {} };
    const comp: CompositeArtifact = {
      ...baseFields,
      id: "sha256:cycle" as CompositeArtifact["id"],
      kind: "composite",
      name: "comp",
      description: "",
      steps: [
        {
          brickId: "sha256:s" as ToolArtifact["id"],
          inputPort: stepPort,
          outputPort: stepPort,
        },
      ],
      exposedInput: port,
      exposedOutput: port,
      outputKind: "tool",
    };
    expect(() => suggestSimplify(comp)).not.toThrow();
    // Cyclic schema is intentionally NOT interchangeable with the step
    // port → simplify suggestion is suppressed.
    expect(suggestSimplify(comp)).toBeUndefined();
  });

  test("suggests simplify for single-step composite", () => {
    const r = suggestSimplify(composite("a", 1));
    expect(r).toBeDefined();
    expect(r?.kind).toBe("simplify");
    expect(r?.reason).toContain("single");
  });

  test("suggests simplify for empty-step composite", () => {
    const r = suggestSimplify(composite("a", 0));
    expect(r).toBeDefined();
  });

  test("returns undefined for multi-step composite", () => {
    expect(suggestSimplify(composite("a", 3))).toBeUndefined();
  });

  test("does not simplify single-step composite when exposed input differs from step", () => {
    const innerPort = { name: "p", schema: {} };
    const outerPort = { name: "wrapper-input", schema: { type: "string" } };
    const c: CompositeArtifact = {
      ...baseFields,
      id: "sha256:a" as CompositeArtifact["id"],
      kind: "composite",
      name: "c",
      description: "",
      steps: [
        {
          brickId: "sha256:step0" as ToolArtifact["id"],
          inputPort: innerPort,
          outputPort: innerPort,
        },
      ],
      exposedInput: outerPort,
      exposedOutput: innerPort,
      outputKind: "tool",
    };
    expect(suggestSimplify(c)).toBeUndefined();
  });

  test("does not simplify single-step composite when exposed output differs from step", () => {
    const innerPort = { name: "p", schema: {} };
    const outerPort = { name: "wrapper-output", schema: { type: "object" } };
    const c: CompositeArtifact = {
      ...baseFields,
      id: "sha256:a" as CompositeArtifact["id"],
      kind: "composite",
      name: "c",
      description: "",
      steps: [
        {
          brickId: "sha256:step0" as ToolArtifact["id"],
          inputPort: innerPort,
          outputPort: innerPort,
        },
      ],
      exposedInput: innerPort,
      exposedOutput: outerPort,
      outputKind: "tool",
    };
    expect(suggestSimplify(c)).toBeUndefined();
  });
});
