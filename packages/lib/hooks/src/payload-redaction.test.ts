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

  it("falls back to structural summary for oversized payloads", () => {
    // Build a payload > 32KB of non-secret content
    const largeValue = "x".repeat(40_000);
    const data: JsonObject = { content: largeValue, name: "test" };
    const result = redactEventData(data, undefined);
    // Should fall back to structure extraction, not contain the raw value
    expect(JSON.stringify(result)).not.toContain(largeValue);
    expect(JSON.stringify(result)).toContain("<string:");
  });

  it("preserves raw payload when under size limit", () => {
    const data: JsonObject = { message: "Hello world", count: 42 };
    const result = redactEventData(data, undefined);
    expect(result).toEqual(data);
  });
});
