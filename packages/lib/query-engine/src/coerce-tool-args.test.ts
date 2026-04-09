import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@koi/core";
import { coerceToolArgs } from "./coerce-tool-args.js";

/** Helper to build a JSON Schema with typed properties. */
function schema(properties: Record<string, { type: string }>): JsonObject {
  return { type: "object", properties } as unknown as JsonObject;
}

describe("coerceToolArgs", () => {
  // -----------------------------------------------------------------------
  // string → number
  // -----------------------------------------------------------------------

  test("coerces string to number when schema says type: number", () => {
    const args: JsonObject = { count: "5" } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ count: { type: "number" } }));
    expect(result).toEqual({ count: 5 });
  });

  test("coerces string float to number", () => {
    const args: JsonObject = { rate: "3.14" } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ rate: { type: "number" } }));
    expect(result).toEqual({ rate: 3.14 });
  });

  test("coerces negative string to number", () => {
    const args: JsonObject = { offset: "-10" } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ offset: { type: "number" } }));
    expect(result).toEqual({ offset: -10 });
  });

  test("leaves non-numeric string unchanged for number type", () => {
    const args: JsonObject = { count: "hello" } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ count: { type: "number" } }));
    expect(result).toEqual({ count: "hello" });
  });

  test("leaves Infinity unchanged for number type", () => {
    const args: JsonObject = { count: "Infinity" } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ count: { type: "number" } }));
    expect(result).toEqual({ count: "Infinity" });
  });

  test("leaves -Infinity unchanged for number type", () => {
    const args: JsonObject = { count: "-Infinity" } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ count: { type: "number" } }));
    expect(result).toEqual({ count: "-Infinity" });
  });

  test("leaves overflow string unchanged for number type", () => {
    const args: JsonObject = { count: "1e309" } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ count: { type: "number" } }));
    expect(result).toEqual({ count: "1e309" });
  });

  test("leaves empty string unchanged for number type", () => {
    const args: JsonObject = { count: "" } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ count: { type: "number" } }));
    expect(result).toEqual({ count: "" });
  });

  // -----------------------------------------------------------------------
  // string → integer
  // -----------------------------------------------------------------------

  test("coerces string to integer when schema says type: integer", () => {
    const args: JsonObject = { count: "5" } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ count: { type: "integer" } }));
    expect(result).toEqual({ count: 5 });
  });

  test("does not coerce float string to integer", () => {
    const args: JsonObject = { count: "3.14" } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ count: { type: "integer" } }));
    expect(result).toEqual({ count: "3.14" });
  });

  // -----------------------------------------------------------------------
  // string → boolean
  // -----------------------------------------------------------------------

  test('coerces "true" to true when schema says type: boolean', () => {
    const args: JsonObject = { verbose: "true" } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ verbose: { type: "boolean" } }));
    expect(result).toEqual({ verbose: true });
  });

  test('coerces "false" to false when schema says type: boolean', () => {
    const args: JsonObject = { verbose: "false" } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ verbose: { type: "boolean" } }));
    expect(result).toEqual({ verbose: false });
  });

  test("leaves non-boolean string unchanged for boolean type", () => {
    const args: JsonObject = { verbose: "yes" } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ verbose: { type: "boolean" } }));
    expect(result).toEqual({ verbose: "yes" });
  });

  // -----------------------------------------------------------------------
  // string → string (no-op)
  // -----------------------------------------------------------------------

  test("leaves string unchanged when schema says type: string", () => {
    const args: JsonObject = { name: "hello" } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ name: { type: "string" } }));
    expect(result).toEqual({ name: "hello" });
    expect(result).toBe(args); // same reference — no clone needed
  });

  // -----------------------------------------------------------------------
  // Non-string values pass through
  // -----------------------------------------------------------------------

  test("leaves number unchanged when schema says type: number", () => {
    const args: JsonObject = { count: 5 } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ count: { type: "number" } }));
    expect(result).toEqual({ count: 5 });
    expect(result).toBe(args);
  });

  test("leaves boolean unchanged when schema says type: boolean", () => {
    const args: JsonObject = { verbose: true } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ verbose: { type: "boolean" } }));
    expect(result).toEqual({ verbose: true });
    expect(result).toBe(args);
  });

  // -----------------------------------------------------------------------
  // Missing/empty schema
  // -----------------------------------------------------------------------

  test("returns args unchanged when schema has no properties", () => {
    const args: JsonObject = { count: "5" } as unknown as JsonObject;
    const result = coerceToolArgs(args, { type: "object" } as unknown as JsonObject);
    expect(result).toBe(args);
  });

  test("returns args unchanged when schema properties is null", () => {
    const args: JsonObject = { count: "5" } as unknown as JsonObject;
    const result = coerceToolArgs(args, { properties: null } as unknown as JsonObject);
    expect(result).toBe(args);
  });

  test("returns args unchanged when schema is empty", () => {
    const args: JsonObject = { count: "5" } as unknown as JsonObject;
    const result = coerceToolArgs(args, {} as JsonObject);
    expect(result).toBe(args);
  });

  // -----------------------------------------------------------------------
  // Mixed properties — only matching keys coerced
  // -----------------------------------------------------------------------

  test("coerces multiple properties independently", () => {
    const args: JsonObject = {
      count: "5",
      verbose: "true",
      name: "test",
    } as unknown as JsonObject;
    const result = coerceToolArgs(
      args,
      schema({
        count: { type: "number" },
        verbose: { type: "boolean" },
        name: { type: "string" },
      }),
    );
    expect(result).toEqual({ count: 5, verbose: true, name: "test" });
  });

  test("preserves keys not in schema properties", () => {
    const args: JsonObject = { count: "5", extra: "data" } as unknown as JsonObject;
    const result = coerceToolArgs(args, schema({ count: { type: "number" } }));
    expect(result).toEqual({ count: 5, extra: "data" });
  });

  // -----------------------------------------------------------------------
  // Immutability
  // -----------------------------------------------------------------------

  test("does not mutate the original args object", () => {
    const args: JsonObject = { count: "5" } as unknown as JsonObject;
    const original = { ...args };
    coerceToolArgs(args, schema({ count: { type: "number" } }));
    expect(args).toEqual(original);
  });
});
