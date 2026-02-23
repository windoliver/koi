import { describe, expect, test } from "bun:test";
import { getKoiConfigJsonSchema } from "./json-schema.js";

describe("getKoiConfigJsonSchema", () => {
  test("returns object with type 'object'", () => {
    const schema = getKoiConfigJsonSchema();
    expect(schema.type).toBe("object");
  });

  test("has properties for all 8 top-level config keys", () => {
    const schema = getKoiConfigJsonSchema();
    const props = schema.properties as Record<string, unknown>;
    const expected = [
      "logLevel",
      "telemetry",
      "limits",
      "loopDetection",
      "spawn",
      "forge",
      "modelRouter",
      "features",
    ];
    for (const key of expected) {
      expect(props[key]).toBeDefined();
    }
  });

  test("has required array with expected fields", () => {
    const schema = getKoiConfigJsonSchema();
    const required = schema.required as readonly string[];
    expect(required).toContain("logLevel");
    expect(required).toContain("limits");
    expect(required).toContain("telemetry");
  });

  test("returns valid JSON-serializable object", () => {
    const schema = getKoiConfigJsonSchema();
    const serialized = JSON.stringify(schema);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(parsed.type).toBe("object");
  });
});
