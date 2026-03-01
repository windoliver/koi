import { describe, expect, test } from "bun:test";
import { generateTestCases } from "./generate-test-cases.js";

// ---------------------------------------------------------------------------
// By schema type
// ---------------------------------------------------------------------------

describe("generateTestCases — string schemas", () => {
  test("generates tests for plain string type", () => {
    const cases = generateTestCases({ type: "string" });
    expect(cases.length).toBeGreaterThanOrEqual(1);
    expect(cases[0]?.name).toBe("auto:minimal_valid");
    expect(typeof cases[0]?.input).toBe("string");
  });

  test("respects minLength", () => {
    const cases = generateTestCases({ type: "string", minLength: 3 });
    const minimal = cases.find((c) => c.name === "auto:minimal_valid");
    expect(minimal?.input).toBe("aaa");
    const boundary = cases.find((c) => c.name === "auto:boundary_min_length");
    expect(boundary?.input).toBe("aaa");
  });

  test("respects maxLength", () => {
    const cases = generateTestCases({ type: "string", maxLength: 5 });
    const boundary = cases.find((c) => c.name === "auto:boundary_max_length");
    expect(boundary?.input).toBe("aaaaa");
  });

  test("generates empty string boundary", () => {
    const cases = generateTestCases({ type: "string" });
    const empty = cases.find((c) => c.name === "auto:boundary_empty_string");
    expect(empty?.input).toBe("");
  });

  test("generates coercion trap: number for string", () => {
    const cases = generateTestCases({ type: "string" });
    const trap = cases.find((c) => c.name === "auto:coercion_number_for_string");
    expect(trap?.input).toBe(123);
  });
});

describe("generateTestCases — number/integer schemas", () => {
  test("generates tests for number type", () => {
    const cases = generateTestCases({ type: "number" });
    expect(cases.length).toBeGreaterThanOrEqual(1);
    const minimal = cases[0];
    expect(minimal?.name).toBe("auto:minimal_valid");
    expect(minimal?.input).toBe(0);
  });

  test("generates boundary values with minimum", () => {
    const cases = generateTestCases({ type: "number", minimum: 10 });
    const minimal = cases.find((c) => c.name === "auto:minimal_valid");
    expect(minimal?.input).toBe(10);
    const boundary = cases.find((c) => c.name === "auto:boundary_minimum");
    expect(boundary?.input).toBe(10);
  });

  test("generates boundary values with maximum", () => {
    const cases = generateTestCases({ type: "number", maximum: 100 });
    const boundary = cases.find((c) => c.name === "auto:boundary_maximum");
    expect(boundary?.input).toBe(100);
  });

  test("generates boundary for exclusiveMinimum (integer)", () => {
    const cases = generateTestCases({ type: "integer", exclusiveMinimum: 5 });
    const minimal = cases.find((c) => c.name === "auto:minimal_valid");
    expect(minimal?.input).toBe(6);
    const boundary = cases.find((c) => c.name === "auto:boundary_above_exclusive_min");
    expect(boundary?.input).toBe(6);
  });

  test("generates boundary for exclusiveMaximum (integer)", () => {
    const cases = generateTestCases({ type: "integer", exclusiveMaximum: 10 });
    const boundary = cases.find((c) => c.name === "auto:boundary_below_exclusive_max");
    expect(boundary?.input).toBe(9);
  });

  test("generates zero and negative boundaries", () => {
    const cases = generateTestCases({ type: "number" });
    expect(cases.find((c) => c.name === "auto:boundary_zero")?.input).toBe(0);
    expect(cases.find((c) => c.name === "auto:boundary_negative")?.input).toBe(-1);
  });

  test("generates coercion traps for number", () => {
    const cases = generateTestCases({ type: "number" });
    const stringTrap = cases.find((c) => c.name === "auto:coercion_string_for_number");
    expect(stringTrap?.input).toBe("1");
    const boolTrap = cases.find((c) => c.name === "auto:coercion_boolean_for_number");
    expect(boolTrap?.input).toBe(true);
  });
});

describe("generateTestCases — boolean schemas", () => {
  test("generates true and false boundaries", () => {
    const cases = generateTestCases({ type: "boolean" });
    expect(cases.find((c) => c.name === "auto:boundary_true")?.input).toBe(true);
    expect(cases.find((c) => c.name === "auto:boundary_false")?.input).toBe(false);
  });

  test("generates coercion traps for boolean", () => {
    const cases = generateTestCases({ type: "boolean" });
    expect(cases.find((c) => c.name === "auto:coercion_zero_for_boolean")?.input).toBe(0);
    expect(cases.find((c) => c.name === "auto:coercion_string_for_boolean")?.input).toBe("true");
  });
});

describe("generateTestCases — array schemas", () => {
  test("generates empty array boundary", () => {
    const cases = generateTestCases({ type: "array" });
    expect(cases.find((c) => c.name === "auto:boundary_empty_array")?.input).toEqual([]);
  });

  test("generates minItems boundary", () => {
    const cases = generateTestCases({ type: "array", minItems: 2, items: { type: "number" } });
    const boundary = cases.find((c) => c.name === "auto:boundary_min_items");
    expect(boundary?.input).toEqual([0, 0]);
  });

  test("generates maxItems boundary", () => {
    const cases = generateTestCases({ type: "array", maxItems: 3, items: { type: "string" } });
    const boundary = cases.find((c) => c.name === "auto:boundary_max_items");
    expect(boundary?.input).toEqual(["", "", ""]);
  });

  test("generates coercion traps for array", () => {
    const cases = generateTestCases({ type: "array" });
    expect(cases.find((c) => c.name === "auto:coercion_object_for_array")?.input).toEqual({});
    expect(cases.find((c) => c.name === "auto:coercion_string_for_array")?.input).toBe("[]");
  });

  test("minimal valid for array with minItems", () => {
    const cases = generateTestCases({ type: "array", minItems: 1, items: { type: "boolean" } });
    const minimal = cases.find((c) => c.name === "auto:minimal_valid");
    expect(minimal?.input).toEqual([false]);
  });
});

describe("generateTestCases — object schemas", () => {
  test("generates tests for object with required and optional fields", () => {
    const schema = {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
    };
    const cases = generateTestCases(schema);
    // Should have minimal_valid (both fields) and required_only (name only)
    const minimal = cases.find((c) => c.name === "auto:minimal_valid");
    expect(minimal?.input).toEqual({ name: "", age: 0 });
    const reqOnly = cases.find((c) => c.name === "auto:required_only");
    expect(reqOnly?.input).toEqual({ name: "" });
  });

  test("generates null variants for optional fields", () => {
    const schema = {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer" },
        label: { type: "string" },
        active: { type: "boolean" },
      },
    };
    const cases = generateTestCases(schema);
    const nullLabel = cases.find((c) => c.name === "auto:null_label");
    expect(nullLabel).toBeDefined();
    expect((nullLabel?.input as Record<string, unknown>).label).toBeNull();
    expect((nullLabel?.input as Record<string, unknown>).id).toBe(0);

    const nullActive = cases.find((c) => c.name === "auto:null_active");
    expect(nullActive).toBeDefined();
    expect((nullActive?.input as Record<string, unknown>).active).toBeNull();
  });

  test("generates empty object boundary", () => {
    const cases = generateTestCases({ type: "object", properties: { x: { type: "number" } } });
    const empty = cases.find((c) => c.name === "auto:boundary_empty_object");
    expect(empty?.input).toEqual({});
  });

  test("generates per-property boundary values", () => {
    const schema = {
      type: "object",
      required: ["count"],
      properties: {
        count: { type: "integer", minimum: 0, maximum: 100 },
      },
    };
    const cases = generateTestCases(schema);
    const minBoundary = cases.find((c) => c.name === "auto:boundary_count_minimum");
    expect(minBoundary).toBeDefined();
    expect((minBoundary?.input as Record<string, unknown>).count).toBe(0);
  });

  test("generates coercion trap: array for object", () => {
    const cases = generateTestCases({ type: "object" });
    const trap = cases.find((c) => c.name === "auto:coercion_array_for_object");
    expect(trap?.input).toEqual([]);
  });

  test("no required_only when identical to minimal_valid", () => {
    // All fields required — required_only === minimal_valid
    const schema = {
      type: "object",
      required: ["x"],
      properties: { x: { type: "number" } },
    };
    const cases = generateTestCases(schema);
    const reqOnly = cases.find((c) => c.name === "auto:required_only");
    // When there are no optional fields, minimal_valid already is required_only
    // so we shouldn't duplicate
    expect(reqOnly).toBeUndefined();
  });
});

describe("generateTestCases — null schemas", () => {
  test("generates null as minimal value", () => {
    const cases = generateTestCases({ type: "null" });
    expect(cases[0]?.input).toBeNull();
  });
});

describe("generateTestCases — enum schemas", () => {
  test("uses first enum value as minimal valid", () => {
    const cases = generateTestCases({ enum: ["red", "green", "blue"] });
    const minimal = cases.find((c) => c.name === "auto:minimal_valid");
    expect(minimal?.input).toBe("red");
  });

  test("handles single enum value", () => {
    const cases = generateTestCases({ enum: [42] });
    const minimal = cases.find((c) => c.name === "auto:minimal_valid");
    expect(minimal?.input).toBe(42);
  });
});

describe("generateTestCases — oneOf/anyOf schemas", () => {
  test("selects first oneOf variant", () => {
    const schema = {
      oneOf: [{ type: "string" }, { type: "number" }],
    };
    const cases = generateTestCases(schema);
    const minimal = cases.find((c) => c.name === "auto:minimal_valid");
    expect(typeof minimal?.input).toBe("string");
  });

  test("selects first anyOf variant", () => {
    const schema = {
      anyOf: [{ type: "number", minimum: 5 }, { type: "string" }],
    };
    const cases = generateTestCases(schema);
    const minimal = cases.find((c) => c.name === "auto:minimal_valid");
    expect(minimal?.input).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// By generation strategy
// ---------------------------------------------------------------------------

describe("generateTestCases — minimal valid input", () => {
  test("generates minimal string", () => {
    const cases = generateTestCases({ type: "string" });
    expect(cases[0]?.input).toBe("");
  });

  test("generates minimal number", () => {
    const cases = generateTestCases({ type: "number" });
    expect(cases[0]?.input).toBe(0);
  });

  test("generates minimal boolean", () => {
    const cases = generateTestCases({ type: "boolean" });
    expect(cases[0]?.input).toBe(false);
  });

  test("generates minimal array", () => {
    const cases = generateTestCases({ type: "array" });
    expect(cases[0]?.input).toEqual([]);
  });

  test("generates minimal object with nested properties", () => {
    const schema = {
      type: "object",
      required: ["config"],
      properties: {
        config: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
    };
    const cases = generateTestCases(schema);
    expect(cases[0]?.input).toEqual({ config: { name: "" } });
  });
});

describe("generateTestCases — required-only", () => {
  test("omits optional fields", () => {
    const schema = {
      type: "object",
      required: ["a"],
      properties: {
        a: { type: "string" },
        b: { type: "number" },
        c: { type: "boolean" },
      },
    };
    const cases = generateTestCases(schema);
    const reqOnly = cases.find((c) => c.name === "auto:required_only");
    expect(reqOnly?.input).toEqual({ a: "" });
  });
});

describe("generateTestCases — null variants", () => {
  test("generates null for each optional field independently", () => {
    const schema = {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "number" },
        x: { type: "string" },
        y: { type: "boolean" },
      },
    };
    const cases = generateTestCases(schema);
    const nullX = cases.find((c) => c.name === "auto:null_x");
    const nullY = cases.find((c) => c.name === "auto:null_y");
    expect(nullX).toBeDefined();
    expect(nullY).toBeDefined();
    expect((nullX?.input as Record<string, unknown>).x).toBeNull();
    expect((nullY?.input as Record<string, unknown>).y).toBeNull();
  });

  test("no null variants for non-object schemas", () => {
    const cases = generateTestCases({ type: "string" });
    const nullCases = cases.filter((c) => c.name.startsWith("auto:null_"));
    expect(nullCases).toHaveLength(0);
  });
});

describe("generateTestCases — boundary values", () => {
  test("generates string boundaries", () => {
    const cases = generateTestCases({ type: "string", minLength: 1, maxLength: 10 });
    expect(cases.find((c) => c.name === "auto:boundary_empty_string")).toBeDefined();
    expect(cases.find((c) => c.name === "auto:boundary_min_length")).toBeDefined();
    expect(cases.find((c) => c.name === "auto:boundary_max_length")).toBeDefined();
  });

  test("generates number boundaries with min/max", () => {
    const cases = generateTestCases({ type: "number", minimum: -10, maximum: 10 });
    expect(cases.find((c) => c.name === "auto:boundary_minimum")?.input).toBe(-10);
    expect(cases.find((c) => c.name === "auto:boundary_maximum")?.input).toBe(10);
    expect(cases.find((c) => c.name === "auto:boundary_zero")?.input).toBe(0);
    expect(cases.find((c) => c.name === "auto:boundary_negative")?.input).toBe(-1);
  });

  test("generates array boundaries", () => {
    const schema = { type: "array", minItems: 1, maxItems: 5, items: { type: "number" } };
    const cases = generateTestCases(schema);
    expect(cases.find((c) => c.name === "auto:boundary_empty_array")).toBeDefined();
    expect(cases.find((c) => c.name === "auto:boundary_min_items")).toBeDefined();
    expect(cases.find((c) => c.name === "auto:boundary_max_items")).toBeDefined();
  });
});

describe("generateTestCases — type coercion traps", () => {
  test("generates wrong-type inputs for number", () => {
    const cases = generateTestCases({ type: "number" });
    expect(cases.find((c) => c.name === "auto:coercion_string_for_number")).toBeDefined();
    expect(cases.find((c) => c.name === "auto:coercion_boolean_for_number")).toBeDefined();
  });

  test("generates wrong-type inputs for object properties", () => {
    const schema = {
      type: "object",
      required: ["val"],
      properties: { val: { type: "number" } },
    };
    const cases = generateTestCases(schema);
    const trap = cases.find((c) => c.name === "auto:coercion_val_string_for_number");
    expect(trap).toBeDefined();
    expect((trap?.input as Record<string, unknown>).val).toBe("1");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("generateTestCases — edge cases", () => {
  test("empty schema generates a single test with empty object", () => {
    const cases = generateTestCases({});
    expect(cases.length).toBeGreaterThanOrEqual(1);
    expect(cases[0]?.name).toBe("auto:minimal_valid");
    expect(cases[0]?.input).toEqual({});
  });

  test("object with no properties generates empty object", () => {
    const cases = generateTestCases({ type: "object" });
    expect(cases[0]?.input).toEqual({});
  });

  test("caps at maxTestCases", () => {
    // A schema that would generate many tests
    const schema = {
      type: "object",
      required: ["a"],
      properties: {
        a: { type: "number", minimum: 0, maximum: 100 },
        b: { type: "string", minLength: 1, maxLength: 50 },
        c: { type: "boolean" },
        d: { type: "array", minItems: 1, maxItems: 10, items: { type: "number" } },
      },
    };
    const cases = generateTestCases(schema, { maxTestCases: 5 });
    expect(cases.length).toBeLessThanOrEqual(5);
  });

  test("maxTestCases of 0 returns empty array", () => {
    const cases = generateTestCases({ type: "string" }, { maxTestCases: 0 });
    expect(cases).toHaveLength(0);
  });

  test("maxTestCases of 1 returns exactly 1 test", () => {
    const cases = generateTestCases({ type: "string" }, { maxTestCases: 1 });
    expect(cases).toHaveLength(1);
  });

  test("default cap is 20", () => {
    // Complex schema producing many tests
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 15; i++) {
      props[`field${i}`] = { type: "number", minimum: 0, maximum: 100 };
    }
    const schema = { type: "object", required: ["field0"], properties: props };
    const cases = generateTestCases(schema);
    expect(cases.length).toBeLessThanOrEqual(20);
  });

  test("deeply nested object generates tests", () => {
    const schema = {
      type: "object",
      required: ["outer"],
      properties: {
        outer: {
          type: "object",
          required: ["inner"],
          properties: {
            inner: { type: "string", minLength: 1 },
          },
        },
      },
    };
    const cases = generateTestCases(schema);
    expect(cases[0]?.input).toEqual({ outer: { inner: "a" } });
  });

  test("all generated tests have name and input", () => {
    const schema = {
      type: "object",
      required: ["x"],
      properties: {
        x: { type: "number" },
        y: { type: "string" },
      },
    };
    const cases = generateTestCases(schema);
    for (const tc of cases) {
      expect(typeof tc.name).toBe("string");
      expect(tc.name.length).toBeGreaterThan(0);
      expect("input" in tc).toBe(true);
    }
  });

  test("no expectedOutput in auto-generated tests (smoke tests)", () => {
    const cases = generateTestCases({ type: "object", properties: { a: { type: "string" } } });
    for (const tc of cases) {
      expect(tc.expectedOutput).toBeUndefined();
    }
  });

  test("all test names are prefixed with auto:", () => {
    const schema = {
      type: "object",
      required: ["x"],
      properties: { x: { type: "number", minimum: 0 } },
    };
    const cases = generateTestCases(schema);
    for (const tc of cases) {
      expect(tc.name).toMatch(/^auto:/);
    }
  });
});
