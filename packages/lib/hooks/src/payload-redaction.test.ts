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
    // let justified: builds the deeply nested object iteratively
    let deep: JsonObject = { leaf: "value" };
    for (let i = 0; i < 10; i++) {
      deep = { nested: deep } as JsonObject;
    }
    const result = extractStructure(deep);
    expect(JSON.stringify(result)).toContain("<truncated>");
  });
});

// ---------------------------------------------------------------------------
// redactEventData — returns { data, status }
// ---------------------------------------------------------------------------

describe("redactEventData", () => {
  it("returns undefined data for undefined input", () => {
    const { data } = redactEventData(undefined, undefined);
    expect(data).toBeUndefined();
  });

  it("passes through data when redaction is explicitly disabled", () => {
    const input: JsonObject = { secret: `sk-ant-api03-${"A".repeat(85)}` };
    const { data, status } = redactEventData(input, { enabled: false });
    expect(data).toEqual(input);
    expect(status).toBe("unredacted");
  });

  it("redacts known secret patterns by default", () => {
    const apiKey = `sk-ant-api03-${"A".repeat(85)}`;
    const input: JsonObject = {
      cmd: `curl -H 'Authorization: Bearer ${apiKey}' https://api.example.com`,
    };
    const { data, status } = redactEventData(input, undefined);
    const cmd = (data as Record<string, string>).cmd;
    expect(cmd).not.toContain(apiKey);
    expect(cmd).toContain("[REDACTED]");
    expect(status).toBe("redacted");
  });

  it("redacts Bearer tokens in strings", () => {
    const input: JsonObject = {
      header:
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    };
    const { data } = redactEventData(input, undefined);
    const header = (data as Record<string, string>).header;
    expect(header).not.toContain("eyJhbGci");
  });

  it("uses mask strategy when configured", () => {
    const input: JsonObject = {
      header:
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    };
    const { data } = redactEventData(input, { censor: "mask" });
    const header = (data as Record<string, string>).header;
    expect(header).toContain("***");
  });

  it("preserves non-secret data unchanged", () => {
    const input: JsonObject = { message: "Hello world", count: 42 };
    const { data, status } = redactEventData(input, undefined);
    expect(data).toEqual(input);
    expect(status).toBe("redacted");
  });

  it("redacts field-name matched values", () => {
    const input: JsonObject = { password: "supersecret123", username: "alice" };
    const { data } = redactEventData(input, undefined);
    expect((data as Record<string, string>).password).toBe("[REDACTED]");
    expect((data as Record<string, string>).username).toBe("alice");
  });

  it("defaults to enabled when config is undefined", () => {
    const input: JsonObject = { password: "my-password" };
    const { data } = redactEventData(input, undefined);
    expect((data as Record<string, string>).password).toBe("[REDACTED]");
  });

  it("defaults to enabled when config is empty object", () => {
    const input: JsonObject = { password: "my-password" };
    const { data } = redactEventData(input, {});
    expect((data as Record<string, string>).password).toBe("[REDACTED]");
  });

  it("redacts custom sensitiveFields", () => {
    const input: JsonObject = { tenantSecret: "my-tenant-key", name: "acme" };
    const { data } = redactEventData(input, { sensitiveFields: ["tenantSecret"] });
    expect((data as Record<string, string>).tenantSecret).toBe("[REDACTED]");
    expect((data as Record<string, string>).name).toBe("acme");
  });

  it("redacts both custom and default sensitiveFields together", () => {
    const input: JsonObject = {
      password: "default-field",
      customKey: "custom-field",
      safe: "ok",
    };
    const { data } = redactEventData(input, { sensitiveFields: ["customKey"] });
    expect((data as Record<string, string>).password).toBe("[REDACTED]");
    expect((data as Record<string, string>).customKey).toBe("[REDACTED]");
    expect((data as Record<string, string>).safe).toBe("ok");
  });

  it("truncates oversized payloads after redaction with correct status", () => {
    const largeValue = "x".repeat(40_000);
    const input: JsonObject = { content: largeValue, name: "test" };
    const { data, status } = redactEventData(input, undefined);
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(largeValue);
    expect(serialized).toContain("_truncated");
    expect(status).toBe("truncated_redacted");
  });

  it("preserves raw payload when under size limit", () => {
    const input: JsonObject = { message: "Hello world", count: 42 };
    const { data } = redactEventData(input, undefined);
    expect(data).toEqual(input);
  });

  it("truncates oversized payloads even when redaction is disabled", () => {
    const largeValue = "x".repeat(40_000);
    const input: JsonObject = { content: largeValue, name: "test" };
    const { data, status } = redactEventData(input, { enabled: false });
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(largeValue);
    expect(serialized).toContain("_truncated");
    expect(status).toBe("truncated_unredacted");
  });

  it("oversized truncation never contains unredacted secrets", () => {
    // Secret near front of a large payload — must be redacted before truncation
    const secret = `sk-ant-api03-${"A".repeat(85)}`;
    const padding = "x".repeat(40_000);
    const input: JsonObject = { apiKey: secret, padding };
    const { data, status } = redactEventData(input, undefined);
    const serialized = JSON.stringify(data);
    // The secret must NOT appear in the truncated content
    expect(serialized).not.toContain(secret);
    expect(status).toBe("truncated_redacted");
  });

  it("handles circular references with structure fallback", () => {
    const input: Record<string, unknown> = { name: "test" };
    input.self = input;
    const { data, status } = redactEventData(input as JsonObject, undefined);
    expect(data).toBeDefined();
    expect(status).toBe("structure_only");
  });

  it("handles BigInt values with structure fallback", () => {
    const input = { value: BigInt(42), name: "test" } as unknown as JsonObject;
    const { data, status } = redactEventData(input, undefined);
    expect(data).toBeDefined();
    expect(status).toBe("structure_only");
  });

  it("uses distinct redactors for sensitiveFields with commas vs separate entries", () => {
    const input: JsonObject = { "x,y": "val1", z: "val2", x: "val3", "y,z": "val4" };
    const { data: d1 } = redactEventData(input, { sensitiveFields: ["x,y", "z"] });
    const { data: d2 } = redactEventData(input, { sensitiveFields: ["x", "y,z"] });
    expect((d1 as Record<string, string>)["x,y"]).toBe("[REDACTED]");
    expect((d1 as Record<string, string>).z).toBe("[REDACTED]");
    expect((d1 as Record<string, string>).x).toBe("val3");
    expect((d1 as Record<string, string>)["y,z"]).toBe("val4");
    expect((d2 as Record<string, string>).x).toBe("[REDACTED]");
    expect((d2 as Record<string, string>)["y,z"]).toBe("[REDACTED]");
    expect((d2 as Record<string, string>)["x,y"]).toBe("val1");
    expect((d2 as Record<string, string>).z).toBe("val2");
  });
});
