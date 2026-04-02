import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { expandEnvVars, expandEnvVarsInRecord } from "./env.js";

describe("expandEnvVars", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TEST_TOKEN = "secret-123";
    process.env.TEST_HOST = "example.com";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("expands a single env var", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
    const result = expandEnvVars("Bearer ${TEST_TOKEN}");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("Bearer secret-123");
    }
  });

  it("expands multiple env vars", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
    const result = expandEnvVars("https://${TEST_HOST}/api?key=${TEST_TOKEN}");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("https://example.com/api?key=secret-123");
    }
  });

  it("returns original string when no patterns", () => {
    const result = expandEnvVars("plain string");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("plain string");
    }
  });

  it("returns error for unresolved env vars", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
    const result = expandEnvVars("${NONEXISTENT_VAR_12345}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["NONEXISTENT_VAR_12345"]);
    }
  });

  it("returns error listing all unresolved vars", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
    const result = expandEnvVars("${MISSING_A} and ${MISSING_B}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["MISSING_A", "MISSING_B"]);
    }
  });

  it("succeeds for empty string", () => {
    const result = expandEnvVars("");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("");
    }
  });

  it("ignores malformed patterns", () => {
    expect(expandEnvVars("$TEST_TOKEN").ok).toBe(true);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
    expect(expandEnvVars("${123BAD}").ok).toBe(true);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
    expect(expandEnvVars("${}").ok).toBe(true);
  });
});

describe("expandEnvVarsInRecord", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TEST_VALUE = "expanded";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("expands all values in record", () => {
    const result = expandEnvVarsInRecord({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
      Authorization: "Bearer ${TEST_VALUE}",
      Plain: "no-expansion",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        Authorization: "Bearer expanded",
        Plain: "no-expansion",
      });
    }
  });

  it("returns empty object for empty input", () => {
    const result = expandEnvVarsInRecord({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({});
    }
  });

  it("returns error when any value has unresolved vars", () => {
    const result = expandEnvVarsInRecord({
      Good: "no-vars",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
      Bad: "Bearer ${MISSING_TOKEN}",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["MISSING_TOKEN"]);
    }
  });
});
