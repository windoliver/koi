import { describe, expect, test } from "bun:test";
import type { PipelineStep } from "@koi/core";
import { brickId, MAX_PIPELINE_STEPS } from "@koi/core";
import { checkSchemaCompatibility, validatePipeline } from "./composition-validation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(
  overrides?: Partial<PipelineStep> & {
    readonly inputSchema?: Readonly<Record<string, unknown>>;
    readonly outputSchema?: Readonly<Record<string, unknown>>;
  },
): PipelineStep {
  return {
    brickId: brickId("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    inputPort: {
      name: "input",
      schema: overrides?.inputSchema ?? { type: "object" },
    },
    outputPort: {
      name: "output",
      schema: overrides?.outputSchema ?? { type: "object" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkSchemaCompatibility
// ---------------------------------------------------------------------------

describe("checkSchemaCompatibility", () => {
  test("same type is compatible", () => {
    const result = checkSchemaCompatibility({ type: "object" }, { type: "object" });
    expect(result.compatible).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("different types are incompatible", () => {
    const result = checkSchemaCompatibility({ type: "string" }, { type: "number" });
    expect(result.compatible).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("type mismatch");
  });

  test("consumer required fields must exist in producer properties", () => {
    const result = checkSchemaCompatibility(
      { type: "object", properties: { a: { type: "string" } } },
      { type: "object", required: ["a", "b"] },
    );
    expect(result.compatible).toBe(false);
    expect(result.errors[0]).toContain("b");
  });

  test("consumer required fields satisfied by producer properties", () => {
    const result = checkSchemaCompatibility(
      { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
      { type: "object", required: ["a"] },
    );
    expect(result.compatible).toBe(true);
  });

  test("nested property type mismatch detected", () => {
    const result = checkSchemaCompatibility(
      { type: "object", properties: { x: { type: "number" } } },
      { type: "object", properties: { x: { type: "string" } } },
    );
    expect(result.compatible).toBe(false);
    expect(result.errors[0]).toContain("x");
  });

  test("max depth guard prevents infinite recursion", () => {
    // Deeply nested schemas — should stop checking at depth limit without error
    const deep = {
      type: "object",
      properties: { a: { type: "object", properties: { b: { type: "string" } } } },
    };
    const result = checkSchemaCompatibility(deep, deep, 1);
    // At depth 1 it checks the top level, then recurses once into properties.a
    // but won't go deeper. Compatible because top-level types match.
    expect(result.compatible).toBe(true);
  });

  test("extra properties in producer are OK", () => {
    const result = checkSchemaCompatibility(
      { type: "object", properties: { a: { type: "string" }, extra: { type: "number" } } },
      { type: "object", properties: { a: { type: "string" } } },
    );
    expect(result.compatible).toBe(true);
  });

  test("empty schemas are compatible", () => {
    const result = checkSchemaCompatibility({}, {});
    expect(result.compatible).toBe(true);
  });

  test("missing properties in consumer is OK", () => {
    const result = checkSchemaCompatibility(
      { type: "object", properties: { a: { type: "string" } } },
      { type: "object" },
    );
    expect(result.compatible).toBe(true);
  });

  test("no type specified is compatible (open constraint)", () => {
    const result = checkSchemaCompatibility(
      { properties: { a: { type: "string" } } },
      { properties: { a: { type: "string" } } },
    );
    expect(result.compatible).toBe(true);
  });

  test("only producer has type — still compatible", () => {
    const result = checkSchemaCompatibility({ type: "object" }, {});
    expect(result.compatible).toBe(true);
  });

  test("only consumer has type — still compatible", () => {
    const result = checkSchemaCompatibility({}, { type: "string" });
    expect(result.compatible).toBe(true);
  });

  test("required is non-array — no error", () => {
    const result = checkSchemaCompatibility(
      { type: "object" },
      { type: "object", required: "not-an-array" },
    );
    expect(result.compatible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validatePipeline
// ---------------------------------------------------------------------------

describe("validatePipeline", () => {
  test("valid 2-step pipeline", () => {
    const result = validatePipeline([makeStep(), makeStep()]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("fewer than 2 steps produces error", () => {
    const result = validatePipeline([makeStep()]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("at least 2");
  });

  test("empty steps produces error", () => {
    const result = validatePipeline([]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("at least 2");
  });

  test("exceeding MAX_PIPELINE_STEPS produces error", () => {
    const steps = Array.from({ length: MAX_PIPELINE_STEPS + 1 }, () => makeStep());
    const result = validatePipeline(steps);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("maximum"))).toBe(true);
  });

  test("incompatible consecutive steps produce errors with step index", () => {
    const steps = [
      makeStep({ outputSchema: { type: "string" } }),
      makeStep({ inputSchema: { type: "number" } }),
    ];
    const result = validatePipeline(steps);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Step 0");
  });

  test("valid 3-step pipeline", () => {
    const result = validatePipeline([makeStep(), makeStep(), makeStep()]);
    expect(result.valid).toBe(true);
  });

  test("reports all errors not just first", () => {
    const steps = [
      makeStep({ outputSchema: { type: "string" } }),
      makeStep({ inputSchema: { type: "number" }, outputSchema: { type: "string" } }),
      makeStep({ inputSchema: { type: "number" } }),
    ];
    const result = validatePipeline(steps);
    expect(result.valid).toBe(false);
    // Both step 0→1 and step 1→2 should have errors
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors.some((e) => e.includes("Step 0"))).toBe(true);
    expect(result.errors.some((e) => e.includes("Step 1"))).toBe(true);
  });

  test("compatible consecutive steps with matching required fields", () => {
    const steps = [
      makeStep({
        outputSchema: {
          type: "object",
          properties: { result: { type: "string" } },
        },
      }),
      makeStep({
        inputSchema: {
          type: "object",
          required: ["result"],
          properties: { result: { type: "string" } },
        },
      }),
    ];
    const result = validatePipeline(steps);
    expect(result.valid).toBe(true);
  });

  test("incompatible required fields produce step-indexed errors", () => {
    const steps = [
      makeStep({
        outputSchema: {
          type: "object",
          properties: { foo: { type: "string" } },
        },
      }),
      makeStep({
        inputSchema: {
          type: "object",
          required: ["bar"],
        },
      }),
    ];
    const result = validatePipeline(steps);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("bar");
  });
});
