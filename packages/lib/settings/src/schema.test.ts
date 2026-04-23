import { describe, expect, test } from "bun:test";
import { getSettingsJsonSchema, validateKoiSettings, validatePolicySettings } from "./schema.js";

describe("validateKoiSettings", () => {
  test("empty object passes", () => {
    const result = validateKoiSettings({});
    expect(result.ok).toBe(true);
  });

  test("full valid settings passes", () => {
    const result = validateKoiSettings({
      permissions: {
        defaultMode: "auto",
        allow: ["Read(*)", "Glob(*)"],
        deny: ["Bash(rm -rf*)"],
        ask: ["Bash(git push*)"],
      },
    });
    expect(result.ok).toBe(true);
  });

  test("invalid defaultMode produces error", () => {
    const result = validateKoiSettings({ permissions: { defaultMode: "invalid" } });
    expect(result.ok).toBe(false);
  });

  test("plan defaultMode is rejected (not yet wired)", () => {
    const result = validateKoiSettings({ permissions: { defaultMode: "plan" } });
    expect(result.ok).toBe(false);
  });

  test("bypass defaultMode is rejected", () => {
    const result = validateKoiSettings({ permissions: { defaultMode: "bypass" } });
    expect(result.ok).toBe(false);
  });

  test("bare glob metacharacter in permission string produces error", () => {
    const result = validateKoiSettings({ permissions: { allow: ["Read**"] } });
    expect(result.ok).toBe(false);
  });

  test("missing closing paren in permission string produces error", () => {
    const result = validateKoiSettings({ permissions: { allow: ["Bash(git push"] } });
    expect(result.ok).toBe(false);
  });

  test("bare tool name is valid", () => {
    const result = validateKoiSettings({ permissions: { allow: ["Read"] } });
    expect(result.ok).toBe(true);
  });

  test("wildcard-only string is valid", () => {
    const result = validateKoiSettings({ permissions: { allow: ["*"] } });
    expect(result.ok).toBe(true);
  });

  test("unknown top-level keys are stripped (not rejected)", () => {
    const result = validateKoiSettings({ unknownKey: true, permissions: { defaultMode: "auto" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as Record<string, unknown>).unknownKey).toBeUndefined();
    }
  });
});

describe("validatePolicySettings", () => {
  test("valid policy passes", () => {
    const result = validatePolicySettings({ permissions: { deny: ["Bash(rm *)"] } });
    expect(result.ok).toBe(true);
  });

  test("unknown top-level key is rejected (not stripped)", () => {
    const result = validatePolicySettings({ permissions: {}, disabledMcpServers: ["risky"] });
    expect(result.ok).toBe(false);
  });

  test("env key is rejected", () => {
    const result = validatePolicySettings({ env: { KEY: "value" } });
    expect(result.ok).toBe(false);
  });

  test("hooks key is rejected", () => {
    const result = validatePolicySettings({ hooks: { PreToolUse: [] } });
    expect(result.ok).toBe(false);
  });
});

describe("getSettingsJsonSchema", () => {
  test("returns an object with $schema key", () => {
    const schema = getSettingsJsonSchema();
    expect(typeof schema).toBe("object");
    expect(schema).not.toBeNull();
  });
});
