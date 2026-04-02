import { describe, expect, test } from "bun:test";
import { applyCensor, applyCensorToField } from "./censor.js";
import type { SecretMatch } from "./types.js";

const match: SecretMatch = {
  text: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
  start: 0,
  end: 33,
  kind: "jwt",
};

describe("applyCensor", () => {
  test("redact strategy returns [REDACTED]", () => {
    expect(applyCensor(match, "redact")).toBe("[REDACTED]");
  });

  test("mask strategy returns first 4 chars + ***", () => {
    expect(applyCensor(match, "mask")).toBe("eyJh***");
  });

  test("mask strategy with short text returns ***", () => {
    const short: SecretMatch = { text: "abc", start: 0, end: 3, kind: "test" };
    expect(applyCensor(short, "mask")).toBe("***");
  });

  test("remove strategy returns empty string", () => {
    expect(applyCensor(match, "remove")).toBe("");
  });

  test("custom function is called with match and fieldName", () => {
    const custom = (m: SecretMatch, field?: string): string => `<${m.kind}:${field ?? "none"}>`;
    expect(applyCensor(match, custom, "authHeader")).toBe("<jwt:authHeader>");
  });
});

describe("applyCensorToField", () => {
  test("creates synthetic match and applies censor", () => {
    expect(applyCensorToField("my-secret", "redact", "password")).toBe("[REDACTED]");
  });

  test("passes field name to custom censor", () => {
    const custom = (_m: SecretMatch, field?: string): string => `***${field}***`;
    expect(applyCensorToField("value", custom, "apiKey")).toBe("***apiKey***");
  });
});
