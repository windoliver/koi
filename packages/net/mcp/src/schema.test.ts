import { describe, expect, test } from "bun:test";
import { normalizeToolSchema } from "./schema.js";

describe("normalizeToolSchema", () => {
  // --- Null / undefined / non-object inputs ---

  test("returns default schema for undefined", () => {
    const result = normalizeToolSchema(undefined);
    expect(result).toEqual({ type: "object", properties: {} });
  });

  test("returns default schema for null", () => {
    const result = normalizeToolSchema(null);
    expect(result).toEqual({ type: "object", properties: {} });
  });

  test("returns default schema for array input", () => {
    const result = normalizeToolSchema([1, 2, 3]);
    expect(result).toEqual({ type: "object", properties: {} });
  });

  test("returns default schema for string input", () => {
    const result = normalizeToolSchema("not a schema");
    expect(result).toEqual({ type: "object", properties: {} });
  });

  test("returns default schema for number input", () => {
    const result = normalizeToolSchema(42);
    expect(result).toEqual({ type: "object", properties: {} });
  });

  // --- Bare / incomplete objects ---

  test("adds type:object and properties to bare empty object", () => {
    const result = normalizeToolSchema({});
    expect(result).toEqual({ type: "object", properties: {} });
  });

  test("adds type:object when missing but properties present", () => {
    const input = { properties: { query: { type: "string" } } };
    const result = normalizeToolSchema(input);
    expect(result).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
    });
  });

  test("adds properties when type:object present but properties missing", () => {
    const result = normalizeToolSchema({ type: "object" });
    expect(result).toEqual({ type: "object", properties: {} });
  });

  // --- Valid schemas pass through ---

  test("passes through a fully valid schema unchanged", () => {
    const input = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name"],
    };
    const result = normalizeToolSchema(input);
    expect(result).toEqual(input);
  });

  test("preserves required array when properties added", () => {
    const input = { type: "object", required: ["id"] };
    const result = normalizeToolSchema(input);
    expect(result).toEqual({
      type: "object",
      properties: {},
      required: ["id"],
    });
  });

  test("preserves additionalProperties field", () => {
    const input = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    const result = normalizeToolSchema(input);
    expect(result).toEqual(input);
  });

  // --- Union / combinator schemas at root ---

  test("passes through anyOf at root without modification", () => {
    const input = {
      anyOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "number" } } },
      ],
    };
    const result = normalizeToolSchema(input);
    expect(result).toEqual(input);
  });

  test("passes through oneOf at root without modification", () => {
    const input = {
      oneOf: [{ type: "string" }, { type: "number" }],
    };
    const result = normalizeToolSchema(input);
    expect(result).toEqual(input);
  });

  // --- Does not mutate input ---

  test("does not mutate the input object", () => {
    const input = { properties: { x: { type: "number" } } };
    const frozen = Object.freeze(input);
    const result = normalizeToolSchema(frozen);
    // Input should not have been mutated
    expect(input).not.toHaveProperty("type");
    // Result should have type added
    expect(result).toHaveProperty("type", "object");
  });
});
