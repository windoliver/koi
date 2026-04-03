import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { HookEnvPolicy } from "@koi/core";
import { buildEnvAllowSet, expandEnvVars, expandEnvVarsInRecord, matchEnvGlob } from "./env.js";

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

  it("returns denied vars when allowlist rejects them", () => {
    const allowed = new Set(["TEST_VALUE"]);
    const result = expandEnvVarsInRecord(
      {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
        Good: "Bearer ${TEST_VALUE}",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
        Bad: "secret=${FORBIDDEN_VAR}",
      },
      allowed,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.denied).toEqual(["FORBIDDEN_VAR"]);
      expect(result.missing).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// matchEnvGlob
// ---------------------------------------------------------------------------

describe("matchEnvGlob", () => {
  it("matches exact name", () => {
    expect(matchEnvGlob("HOOK_TOKEN", "HOOK_TOKEN")).toBe(true);
  });

  it("rejects non-matching exact name", () => {
    expect(matchEnvGlob("HOOK_TOKEN", "OTHER_TOKEN")).toBe(false);
  });

  it("matches wildcard suffix", () => {
    expect(matchEnvGlob("HOOK_*", "HOOK_TOKEN")).toBe(true);
    expect(matchEnvGlob("HOOK_*", "HOOK_SECRET")).toBe(true);
    expect(matchEnvGlob("HOOK_*", "HOOK_")).toBe(true);
  });

  it("rejects wildcard suffix when prefix differs", () => {
    expect(matchEnvGlob("HOOK_*", "OTHER_TOKEN")).toBe(false);
  });

  it("matches wildcard prefix", () => {
    expect(matchEnvGlob("*_SECRET", "WEBHOOK_SECRET")).toBe(true);
  });

  it("matches question mark wildcard", () => {
    expect(matchEnvGlob("HOOK_?", "HOOK_A")).toBe(true);
    expect(matchEnvGlob("HOOK_?", "HOOK_AB")).toBe(false);
  });

  it("matches middle wildcard", () => {
    expect(matchEnvGlob("HOOK_*_KEY", "HOOK_AUTH_KEY")).toBe(true);
    expect(matchEnvGlob("HOOK_*_KEY", "HOOK_KEY")).toBe(false);
  });

  it("escapes regex special characters", () => {
    expect(matchEnvGlob("HOOK.TOKEN", "HOOK.TOKEN")).toBe(true);
    expect(matchEnvGlob("HOOK.TOKEN", "HOOKXTOKEN")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildEnvAllowSet
// ---------------------------------------------------------------------------

describe("buildEnvAllowSet", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.HOOK_TOKEN = "t1";
    process.env.HOOK_SECRET = "s1";
    process.env.WEBHOOK_KEY = "w1";
    process.env.DATABASE_URL = "pg://localhost";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns undefined when both inputs are undefined", () => {
    expect(buildEnvAllowSet(undefined, undefined)).toBeUndefined();
  });

  it("returns set of hook vars when only hook allowlist is provided", () => {
    const result = buildEnvAllowSet(["HOOK_TOKEN", "HOOK_SECRET"], undefined);
    expect(result).toEqual(new Set(["HOOK_TOKEN", "HOOK_SECRET"]));
  });

  it("returns empty set when policy is active but hook omits allowedEnvVars", () => {
    const policy: HookEnvPolicy = { allowedPatterns: ["HOOK_*"] };
    const result = buildEnvAllowSet(undefined, policy);
    // Hooks must explicitly declare vars when policy is active
    expect(result).toEqual(new Set());
  });

  it("returns intersection when both are provided", () => {
    const policy: HookEnvPolicy = { allowedPatterns: ["HOOK_*"] };
    // WEBHOOK_KEY is in hook list but not matched by policy
    const result = buildEnvAllowSet(["HOOK_TOKEN", "WEBHOOK_KEY"], policy);
    expect(result).toBeInstanceOf(Set);
    const set = result as ReadonlySet<string>;
    expect(set.has("HOOK_TOKEN")).toBe(true);
    expect(set.has("WEBHOOK_KEY")).toBe(false);
  });

  it("returns empty set when hook list has no vars matching policy", () => {
    const policy: HookEnvPolicy = { allowedPatterns: ["HOOK_*"] };
    const result = buildEnvAllowSet(["DATABASE_URL"], policy);
    expect(result).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// expandEnvVars with allowlist
// ---------------------------------------------------------------------------

describe("expandEnvVars with allowlist", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.ALLOWED_TOKEN = "secret-123";
    process.env.FORBIDDEN_SECRET = "db-password";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves allowed var normally", () => {
    const allowed = new Set(["ALLOWED_TOKEN"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
    const result = expandEnvVars("Bearer ${ALLOWED_TOKEN}", allowed);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("Bearer secret-123");
    }
  });

  it("denies var not in allowlist", () => {
    const allowed = new Set(["ALLOWED_TOKEN"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
    const result = expandEnvVars("${FORBIDDEN_SECRET}", allowed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.denied).toEqual(["FORBIDDEN_SECRET"]);
      expect(result.missing).toEqual([]);
    }
  });

  it("reports both missing and denied vars", () => {
    // ALLOWED_TOKEN is in allowlist + env, FORBIDDEN_SECRET is in env but not allowlist,
    // NONEXISTENT_VAR is in allowlist but not in env
    const allowed = new Set(["ALLOWED_TOKEN", "NONEXISTENT_VAR"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
    const result = expandEnvVars("${FORBIDDEN_SECRET} ${NONEXISTENT_VAR}", allowed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.denied).toEqual(["FORBIDDEN_SECRET"]);
      expect(result.missing).toEqual(["NONEXISTENT_VAR"]);
    }
  });

  it("allows all vars when allowlist is undefined (backward compat)", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
    const result = expandEnvVars("${FORBIDDEN_SECRET}", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("db-password");
    }
  });

  it("denies all vars when allowlist is empty set", () => {
    const allowed = new Set<string>();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var substitution
    const result = expandEnvVars("${ALLOWED_TOKEN}", allowed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.denied).toEqual(["ALLOWED_TOKEN"]);
    }
  });
});
