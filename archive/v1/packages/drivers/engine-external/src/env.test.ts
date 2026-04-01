import { describe, expect, test } from "bun:test";
import { resolveEnv } from "./env.js";

describe("resolveEnv", () => {
  test("undefined strategy applies safe allowlist", () => {
    const env = resolveEnv(undefined);

    // Should include PATH (almost always set)
    if (process.env.PATH !== undefined) {
      expect(env.PATH).toBe(process.env.PATH);
    }

    // Should NOT include secret-like keys
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SECRET_TOKEN).toBeUndefined();
  });

  test("allowlist strategy filters correctly", () => {
    const env = resolveEnv({ kind: "allowlist", keys: ["PATH", "HOME"] });

    if (process.env.PATH !== undefined) {
      expect(env.PATH).toBe(process.env.PATH);
    }
    if (process.env.HOME !== undefined) {
      expect(env.HOME).toBe(process.env.HOME);
    }

    // Keys not in allowlist should be absent
    expect(env.LANG).toBeUndefined();
  });

  test("explicit strategy passes through only provided vars", () => {
    const env = resolveEnv({
      kind: "explicit",
      env: { FOO: "bar", BAZ: "qux" },
    });

    expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("inherit returns full process.env entries", () => {
    const env = resolveEnv({ kind: "inherit" });

    // Should have at least PATH
    if (process.env.PATH !== undefined) {
      expect(env.PATH).toBe(process.env.PATH);
    }

    // Should include more keys than the safe allowlist
    expect(Object.keys(env).length).toBeGreaterThanOrEqual(
      Object.keys(resolveEnv(undefined)).length,
    );
  });

  test("allowlist with non-existent keys returns empty for those keys", () => {
    const env = resolveEnv({
      kind: "allowlist",
      keys: ["__DEFINITELY_NOT_SET_12345__"],
    });

    expect(env.__DEFINITELY_NOT_SET_12345__).toBeUndefined();
    expect(Object.keys(env).length).toBe(0);
  });
});
