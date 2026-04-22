import { describe, expect, test } from "bun:test";
import { validateLoadedSchema, validateResultSchema, validateSchema } from "./validate-schema.js";

describe("validateLoadedSchema — shape checks", () => {
  test("accepts a plain object with known keyword", () => {
    const result = validateLoadedSchema({ type: "object" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.schema).toEqual({ type: "object" });
  });

  test("rejects null", () => {
    const result = validateLoadedSchema(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("JSON object");
  });

  test("rejects array", () => {
    const result = validateLoadedSchema([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("JSON object");
  });

  test("rejects schema with unsupported keyword $ref at boot", () => {
    const result = validateLoadedSchema({ $ref: "#/definitions/Foo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("$ref");
  });

  test("accepts schema where type is 'integer'", () => {
    const result = validateLoadedSchema({ type: "integer" });
    expect(result.ok).toBe(true);
  });

  test("rejects schema where type is an array instead of string", () => {
    const result = validateLoadedSchema({ type: ["string", "null"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("type");
  });

  test("rejects schema where enum is not an array", () => {
    const result = validateLoadedSchema({ enum: "open" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("enum");
  });

  test("rejects schema where enum contains non-scalar values (objects)", () => {
    const result = validateLoadedSchema({ enum: [{ status: "open" }, "closed"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("scalar");
  });

  test("rejects schema where required is not an array of strings", () => {
    const result = validateLoadedSchema({ required: "count" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("required");
  });

  test("rejects schema where properties is not an object", () => {
    const result = validateLoadedSchema({ properties: ["count"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("properties");
  });

  test("accepts annotation keywords $schema, title, description, $comment", () => {
    const result = validateLoadedSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "PR summary",
      description: "output schema",
      $comment: "internal note",
      type: "object",
    });
    expect(result.ok).toBe(true);
  });

  test("rejects schema with unsupported keyword 'pattern'", () => {
    const result = validateLoadedSchema({ type: "string", pattern: "^[a-z]+$" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("pattern");
  });

  test("validates nested properties recursively", () => {
    const result = validateLoadedSchema({
      type: "object",
      properties: {
        nested: { type: "string", $ref: "#" },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("$ref");
  });

  test("validates items keyword recursively", () => {
    const result = validateLoadedSchema({
      type: "array",
      items: { $ref: "#/definitions/item" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("$ref");
  });
});

describe("validateSchema — runtime validation", () => {
  test("passes: object with required fields present", () => {
    const result = validateSchema(
      { count: 3, titles: ["a", "b"] },
      { type: "object", required: ["count", "titles"] },
    );
    expect(result.ok).toBe(true);
  });

  test("fails: required field missing", () => {
    const result = validateSchema({ count: 3 }, { type: "object", required: ["count", "titles"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("titles");
      expect(result.message).toContain("required");
    }
  });

  test("fails: wrong type — string where number expected", () => {
    const result = validateSchema("hello", { type: "number" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("number");
  });

  test("passes: null value with type 'null'", () => {
    const result = validateSchema(null, { type: "null" });
    expect(result.ok).toBe(true);
  });

  test("fails: null where string expected", () => {
    const result = validateSchema(null, { type: "string" });
    expect(result.ok).toBe(false);
  });

  test("passes: array with items schema — all elements match", () => {
    const result = validateSchema(["a", "b", "c"], { type: "array", items: { type: "string" } });
    expect(result.ok).toBe(true);
  });

  test("fails: array with items schema — element mismatch", () => {
    const result = validateSchema(["a", 42, "c"], { type: "array", items: { type: "string" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.path).toContain("[1]");
  });

  test("passes: enum — value is in list", () => {
    const result = validateSchema("open", { enum: ["open", "closed"] });
    expect(result.ok).toBe(true);
  });

  test("fails: enum — value not in list", () => {
    const result = validateSchema("pending", { enum: ["open", "closed"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("one of");
  });

  test("passes: integer — whole number", () => {
    const result = validateSchema(42, { type: "integer" });
    expect(result.ok).toBe(true);
  });

  test("fails: integer — fractional number rejected", () => {
    const result = validateSchema(3.14, { type: "integer" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("fractional");
  });

  test("fails: integer — string not accepted for integer type", () => {
    const result = validateSchema("42", { type: "integer" });
    expect(result.ok).toBe(false);
  });

  test("passes: nested properties validation", () => {
    const result = validateSchema(
      { user: { name: "Alice" } },
      {
        type: "object",
        properties: {
          user: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
    );
    expect(result.ok).toBe(true);
  });

  test("fails: nested properties — wrong type at depth", () => {
    const result = validateSchema(
      { user: { name: 123 } },
      {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: { name: { type: "string" } },
          },
        },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.path).toContain("user.name");
  });

  test("returns error for unsupported keyword in runtime schema", () => {
    const result = validateSchema("hello", { type: "string", pattern: "^[a-z]" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("pattern");
  });
});

describe("validateResultSchema — end-to-end schema validation path", () => {
  const schema: Record<string, unknown> = {
    type: "object",
    required: ["count", "titles"],
    properties: {
      count: { type: "number" },
      titles: { type: "array" },
    },
  };

  test("success: valid JSON matching schema → ok true", () => {
    const result = validateResultSchema('{"count":3,"titles":["a","b","c"]}', schema);
    expect(result.ok).toBe(true);
  });

  test("non-JSON output → ok false, error contains 'not valid JSON'", () => {
    const result = validateResultSchema("Here is your summary: ...", schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not valid JSON");
  });

  test("valid JSON missing required field → ok false, error contains field name", () => {
    const result = validateResultSchema('{"count":3}', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("schema validation failed");
      expect(result.error).toContain("titles");
    }
  });

  test("valid JSON wrong field type → ok false, error contains field path", () => {
    const result = validateResultSchema('{"count":"three","titles":[]}', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("count");
  });

  test("empty assembled text → ok false (empty string is not valid JSON)", () => {
    const result = validateResultSchema("", schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not valid JSON");
  });

  test("multi-chunk assembly: concatenated deltas validate as one JSON blob", () => {
    const chunk1 = '{"count":2,"tit';
    const chunk2 = 'les":["foo",';
    const chunk3 = '"bar"]}';
    const assembled = chunk1 + chunk2 + chunk3;
    const result = validateResultSchema(assembled, schema);
    expect(result.ok).toBe(true);
  });
});
