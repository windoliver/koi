import { describe, expect, test } from "bun:test";
import { createFieldMatcher } from "./field-match.js";

describe("createFieldMatcher", () => {
  test("returns false for empty fieldNames", () => {
    const matcher = createFieldMatcher([]);
    expect(matcher("password")).toBe(false);
    expect(matcher("anything")).toBe(false);
  });

  test("matches exact strings case-insensitively", () => {
    const matcher = createFieldMatcher(["password", "apiKey"]);
    expect(matcher("password")).toBe(true);
    expect(matcher("PASSWORD")).toBe(true);
    expect(matcher("Password")).toBe(true);
    expect(matcher("apiKey")).toBe(true);
    expect(matcher("APIKEY")).toBe(true);
    expect(matcher("username")).toBe(false);
  });

  test("matches regex patterns", () => {
    const matcher = createFieldMatcher([/^secret_/i]);
    expect(matcher("secret_key")).toBe(true);
    expect(matcher("SECRET_TOKEN")).toBe(true);
    expect(matcher("my_secret")).toBe(false);
  });

  test("matches mixed exact + regex", () => {
    const matcher = createFieldMatcher(["token", /^x-api-/i]);
    expect(matcher("token")).toBe(true);
    expect(matcher("x-api-key")).toBe(true);
    expect(matcher("other")).toBe(false);
  });

  test("exact match takes priority (fast path)", () => {
    const matcher = createFieldMatcher(["password"]);
    // Should match via Set.has — O(1)
    expect(matcher("password")).toBe(true);
    expect(matcher("not-password")).toBe(false);
  });
});
