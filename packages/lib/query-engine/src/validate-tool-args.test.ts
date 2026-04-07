import { describe, expect, test } from "bun:test";
import type { ToolDescriptor } from "@koi/core";
import { validateToolArgs } from "./validate-tool-args.js";

function desc(schema: Record<string, unknown>): ToolDescriptor {
  return { name: "test", description: "", inputSchema: schema };
}

describe("validateToolArgs", () => {
  test("passes when no schema constraints", () => {
    expect(validateToolArgs({ anything: "goes" }, desc({}))).toBeUndefined();
  });

  test("passes when required fields are present", () => {
    const result = validateToolArgs(
      { path: "/foo", encoding: "utf8" },
      desc({ required: ["path", "encoding"] }),
    );
    expect(result).toBeUndefined();
  });

  test("rejects missing required fields", () => {
    const result = validateToolArgs({ encoding: "utf8" }, desc({ required: ["path", "encoding"] }));
    expect(result).toContain("missing required field(s): path");
  });

  test("rejects wrong type: expected string got number", () => {
    const result = validateToolArgs(
      { path: 123 },
      desc({ properties: { path: { type: "string" } } }),
    );
    expect(result).toContain('field "path" expected string, got number');
  });

  test("rejects wrong type: expected number got string", () => {
    const result = validateToolArgs(
      { count: "five" },
      desc({ properties: { count: { type: "number" } } }),
    );
    expect(result).toContain('field "count" expected number, got string');
  });

  test("rejects float when integer expected", () => {
    const result = validateToolArgs(
      { count: 3.14 },
      desc({ properties: { count: { type: "integer" } } }),
    );
    expect(result).toContain("expected integer, got float");
  });

  test("rejects wrong type: expected boolean got string", () => {
    const result = validateToolArgs(
      { flag: "true" },
      desc({ properties: { flag: { type: "boolean" } } }),
    );
    expect(result).toContain('field "flag" expected boolean, got string');
  });

  test("rejects wrong type: expected array got object", () => {
    const result = validateToolArgs(
      { items: {} },
      desc({ properties: { items: { type: "array" } } }),
    );
    expect(result).toContain('field "items" expected array, got object');
  });

  test("rejects wrong type: expected object got array", () => {
    const result = validateToolArgs(
      { config: [] },
      desc({ properties: { config: { type: "object" } } }),
    );
    expect(result).toContain('field "config" expected object, got array');
  });

  test("passes correct types", () => {
    const result = validateToolArgs(
      { name: "foo", count: 5, flag: true, items: [1], config: { a: 1 } },
      desc({
        properties: {
          name: { type: "string" },
          count: { type: "integer" },
          flag: { type: "boolean" },
          items: { type: "array" },
          config: { type: "object" },
        },
      }),
    );
    expect(result).toBeUndefined();
  });

  test("rejects additional properties when disallowed", () => {
    const result = validateToolArgs(
      { path: "/foo", secret: "key" },
      desc({
        properties: { path: { type: "string" } },
        additionalProperties: false,
      }),
    );
    expect(result).toContain("unexpected additional field(s): secret");
  });

  test("allows additional properties when not restricted", () => {
    const result = validateToolArgs(
      { path: "/foo", extra: "ok" },
      desc({ properties: { path: { type: "string" } } }),
    );
    expect(result).toBeUndefined();
  });

  test("skips type check for missing optional fields", () => {
    const result = validateToolArgs({}, desc({ properties: { optional: { type: "string" } } }));
    expect(result).toBeUndefined();
  });

  test("rejects schema with unsupported root keyword oneOf", () => {
    const result = validateToolArgs(
      { x: 1 },
      desc({ oneOf: [{ type: "string" }, { type: "number" }] }),
    );
    expect(result).toContain('unsupported keyword "oneOf"');
  });

  test("rejects schema with unsupported root keyword anyOf", () => {
    const result = validateToolArgs({ x: 1 }, desc({ anyOf: [{}] }));
    expect(result).toContain('unsupported keyword "anyOf"');
  });

  test("rejects schema with unsupported root keyword allOf", () => {
    const result = validateToolArgs({ x: 1 }, desc({ allOf: [{}] }));
    expect(result).toContain('unsupported keyword "allOf"');
  });

  test("passes array property with items schema keyword (structural, not deeply validated)", () => {
    // Regression: fs_edit schema uses 'items' on the edits array property.
    // The validator must accept 'items' without deep-validating its contents.
    const result = validateToolArgs(
      { path: "edit-test.txt", edits: [{ oldText: "hello", newText: "goodbye" }] },
      desc({
        properties: {
          path: { type: "string", description: "File path" },
          edits: {
            type: "array",
            description: "Array of hunks",
            items: {
              type: "object",
              properties: { oldText: { type: "string" }, newText: { type: "string" } },
              required: ["oldText", "newText"],
            },
          },
        },
        required: ["path", "edits"],
      }),
    );
    expect(result).toBeUndefined();
  });

  test("accepts property with enum keyword (recognized, not deeply validated)", () => {
    const result = validateToolArgs(
      { mode: "fast" },
      desc({ properties: { mode: { type: "string", enum: ["fast", "slow"] } } }),
    );
    expect(result).toBeUndefined();
  });

  test("accepts property with pattern keyword (recognized, not deeply validated)", () => {
    const result = validateToolArgs(
      { id: "abc" },
      desc({ properties: { id: { type: "string", pattern: "^[0-9]+$" } } }),
    );
    expect(result).toBeUndefined();
  });

  test("rejects additionalProperties as subschema object", () => {
    const result = validateToolArgs(
      { name: "foo", extra: "bar" },
      desc({
        properties: { name: { type: "string" } },
        additionalProperties: { type: "string" },
      }),
    );
    expect(result).toContain("additionalProperties");
    expect(result).toContain("subschema");
  });

  test("allows additionalProperties: true", () => {
    const result = validateToolArgs(
      { name: "foo", extra: "bar" },
      desc({
        properties: { name: { type: "string" } },
        additionalProperties: true,
      }),
    );
    expect(result).toBeUndefined();
  });

  test("additionalProperties: false without properties rejects any keys", () => {
    const result = validateToolArgs({ unexpected: "value" }, desc({ additionalProperties: false }));
    expect(result).toContain("unexpected additional field(s): unexpected");
  });

  test("additionalProperties: false without properties allows empty args", () => {
    const result = validateToolArgs({}, desc({ additionalProperties: false }));
    expect(result).toBeUndefined();
  });

  test("rejects unsupported type value (typo)", () => {
    const result = validateToolArgs(
      { name: "foo" },
      desc({ properties: { name: { type: "strng" } } }),
    );
    expect(result).toContain('unsupported type "strng"');
  });

  test("rejects union type array", () => {
    const result = validateToolArgs(
      { value: "foo" },
      desc({ properties: { value: { type: ["string", "null"] } } }),
    );
    expect(result).toContain("unsupported type");
  });
});
