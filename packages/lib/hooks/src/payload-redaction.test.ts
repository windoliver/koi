import { describe, expect, it } from "bun:test";
import type { JsonObject } from "@koi/core";
import { extractStructure, redactEventData } from "./payload-redaction.js";

// ---------------------------------------------------------------------------
// extractStructure
// ---------------------------------------------------------------------------

describe("extractStructure", () => {
  it("returns undefined for undefined data", () => {
    expect(extractStructure(undefined)).toBeUndefined();
  });

  it("replaces string values with type+length placeholders", () => {
    const data: JsonObject = { cmd: "rm -rf /", name: "hi" };
    const result = extractStructure(data);
    expect(result).toEqual({ cmd: "<string:8>", name: "<string:2>" });
  });

  it("replaces number values with type placeholder", () => {
    const data: JsonObject = { count: 42, ratio: 3.14 };
    const result = extractStructure(data);
    expect(result).toEqual({ count: "<number>", ratio: "<number>" });
  });

  it("replaces boolean values with type placeholder", () => {
    const data: JsonObject = { enabled: true, debug: false };
    const result = extractStructure(data);
    expect(result).toEqual({ enabled: "<boolean>", debug: "<boolean>" });
  });

  it("preserves null values", () => {
    const data: JsonObject = { value: null };
    const result = extractStructure(data);
    expect(result).toEqual({ value: null });
  });

  it("recursively extracts nested object structure", () => {
    const data: JsonObject = {
      input: { cmd: "echo hello", env: { HOME: "/root" } },
    };
    const result = extractStructure(data);
    expect(result).toEqual({
      input: { cmd: "<string:10>", env: { HOME: "<string:5>" } },
    });
  });

  it("summarizes arrays with element structure", () => {
    const data: JsonObject = { items: ["a", "b"] };
    const result = extractStructure(data);
    expect(result).toEqual({ items: ["<string:1>", "<string:1>"] });
  });

  it("truncates long arrays with count indicator", () => {
    const data: JsonObject = { items: [1, 2, 3, 4, 5] };
    const result = extractStructure(data);
    const items = (result as Record<string, unknown>).items as unknown[];
    expect(items).toHaveLength(4); // 3 previewed + 1 "more" indicator
    expect(items[3]).toBe("<...2 more>");
  });

  it("truncates deeply nested structures", () => {
    // Build a structure 10 levels deep — should truncate at depth 8
    // let justified: builds the deeply nested object iteratively
    let deep: JsonObject = { leaf: "value" };
    for (let i = 0; i < 10; i++) {
      deep = { nested: deep } as JsonObject;
    }
    const result = extractStructure(deep);
    // Should not throw and should contain truncation marker somewhere
    expect(JSON.stringify(result)).toContain("<truncated>");
  });
});

// ---------------------------------------------------------------------------
// redactEventData
// ---------------------------------------------------------------------------

describe("redactEventData", () => {
  it("returns undefined for undefined data", () => {
    expect(redactEventData(undefined, undefined)).toBeUndefined();
  });

  it("passes through data when redaction is explicitly disabled", () => {
    const data: JsonObject = { secret: `sk-ant-api03-${"A".repeat(85)}` };
    const result = redactEventData(data, { enabled: false });
    expect(result).toEqual(data);
  });

  it("redacts known secret patterns by default", () => {
    const apiKey = `sk-ant-api03-${"A".repeat(85)}`;
    const data: JsonObject = {
      cmd: `curl -H 'Authorization: Bearer ${apiKey}' https://api.example.com`,
    };
    const result = redactEventData(data, undefined);
    const cmd = (result as Record<string, string>).cmd;
    expect(cmd).not.toContain(apiKey);
    expect(cmd).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens in strings", () => {
    const data: JsonObject = {
      header:
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    };
    const result = redactEventData(data, undefined);
    const header = (result as Record<string, string>).header;
    expect(header).not.toContain("eyJhbGci");
  });

  it("uses mask strategy when configured", () => {
    const data: JsonObject = {
      header:
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    };
    const result = redactEventData(data, { censor: "mask" });
    const header = (result as Record<string, string>).header;
    // Mask preserves first 4 chars + "***"
    expect(header).toContain("***");
  });

  it("preserves non-secret data unchanged", () => {
    const data: JsonObject = { message: "Hello world", count: 42 };
    const result = redactEventData(data, undefined);
    expect(result).toEqual(data);
  });

  it("redacts field-name matched values", () => {
    const data: JsonObject = { password: "supersecret123", username: "alice" };
    const result = redactEventData(data, undefined);
    expect((result as Record<string, string>).password).toBe("[REDACTED]");
    expect((result as Record<string, string>).username).toBe("alice");
  });

  it("defaults to enabled when config is undefined", () => {
    const data: JsonObject = { password: "my-password" };
    const result = redactEventData(data, undefined);
    expect((result as Record<string, string>).password).toBe("[REDACTED]");
  });

  it("defaults to enabled when config is empty object", () => {
    const data: JsonObject = { password: "my-password" };
    const result = redactEventData(data, {});
    expect((result as Record<string, string>).password).toBe("[REDACTED]");
  });

  it("redacts custom sensitiveFields", () => {
    const data: JsonObject = { tenantSecret: "my-tenant-key", name: "acme" };
    const result = redactEventData(data, { sensitiveFields: ["tenantSecret"] });
    expect((result as Record<string, string>).tenantSecret).toBe("[REDACTED]");
    expect((result as Record<string, string>).name).toBe("acme");
  });

  it("redacts both custom and default sensitiveFields together", () => {
    const data: JsonObject = {
      password: "default-field",
      customKey: "custom-field",
      safe: "ok",
    };
    const result = redactEventData(data, { sensitiveFields: ["customKey"] });
    expect((result as Record<string, string>).password).toBe("[REDACTED]");
    expect((result as Record<string, string>).customKey).toBe("[REDACTED]");
    expect((result as Record<string, string>).safe).toBe("ok");
  });

  it("truncates oversized payloads with explicit notice", () => {
    const largeValue = "x".repeat(40_000);
    const data: JsonObject = { content: largeValue, name: "test" };
    const result = redactEventData(data, undefined);
    const serialized = JSON.stringify(result);
    // Should not contain the full large value
    expect(serialized).not.toContain(largeValue);
    // Should contain truncation metadata
    expect(serialized).toContain("_truncated");
    expect(serialized).toContain("_notice");
  });

  it("preserves raw payload when under size limit", () => {
    const data: JsonObject = { message: "Hello world", count: 42 };
    const result = redactEventData(data, undefined);
    expect(result).toEqual(data);
  });

  it("truncates oversized payloads even when redaction is disabled", () => {
    const largeValue = "x".repeat(40_000);
    const data: JsonObject = { content: largeValue, name: "test" };
    const result = redactEventData(data, { enabled: false });
    const serialized = JSON.stringify(result);
    // Size guard should still trigger with truncation notice
    expect(serialized).not.toContain(largeValue);
    expect(serialized).toContain("_truncated");
  });

  it("handles circular references with notice instead of throwing", () => {
    const data: Record<string, unknown> = { name: "test" };
    data.self = data; // circular reference
    const result = redactEventData(data as JsonObject, undefined);
    // Should not throw — should produce a notice with structure
    expect(result).toBeDefined();
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("_truncated");
    expect(serialized).toContain("circular");
  });

  it("handles BigInt values with notice instead of throwing", () => {
    const data = { value: BigInt(42), name: "test" } as unknown as JsonObject;
    const result = redactEventData(data, undefined);
    // Should not throw
    expect(result).toBeDefined();
    expect(JSON.stringify(result)).toContain("_truncated");
  });

  it("uses distinct redactors for sensitiveFields with commas vs separate entries", () => {
    // ["x,y", "z"] vs ["x", "y,z"] would collide with comma-join but not JSON encoding.
    // Verify each config redacts only ITS listed fields, not the other's.
    const data: JsonObject = { "x,y": "val1", z: "val2", x: "val3", "y,z": "val4" };
    const result1 = redactEventData(data, { sensitiveFields: ["x,y", "z"] });
    const result2 = redactEventData(data, { sensitiveFields: ["x", "y,z"] });
    // Config 1: "x,y" and "z" are sensitive
    expect((result1 as Record<string, string>)["x,y"]).toBe("[REDACTED]");
    expect((result1 as Record<string, string>).z).toBe("[REDACTED]");
    // Config 1: "x" and "y,z" are NOT in config 1's list
    expect((result1 as Record<string, string>).x).toBe("val3");
    expect((result1 as Record<string, string>)["y,z"]).toBe("val4");
    // Config 2: "x" and "y,z" are sensitive
    expect((result2 as Record<string, string>).x).toBe("[REDACTED]");
    expect((result2 as Record<string, string>)["y,z"]).toBe("[REDACTED]");
    // Config 2: "x,y" and "z" are NOT in config 2's list
    expect((result2 as Record<string, string>)["x,y"]).toBe("val1");
    expect((result2 as Record<string, string>).z).toBe("val2");
  });
});
