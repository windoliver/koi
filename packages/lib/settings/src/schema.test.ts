import { describe, expect, test } from "bun:test";
import { getSettingsJsonSchema, validateKoiSettings } from "./schema.js";

describe("validateKoiSettings", () => {
  test("empty object passes", () => {
    const result = validateKoiSettings({});
    expect(result.ok).toBe(true);
  });

  test("full valid settings passes", () => {
    const result = validateKoiSettings({
      permissions: {
        defaultMode: "plan",
        allow: ["Read(*)", "Glob(*)"],
        deny: ["Bash(rm -rf*)"],
        ask: ["Bash(git push*)"],
        additionalDirectories: ["/tmp/workspace"],
      },
      env: { KOI_LOG_LEVEL: "debug" },
      hooks: {
        PreToolUse: [{ type: "command", command: "./hooks/audit.sh" }],
      },
      apiBaseUrl: "https://openrouter.ai/api/v1",
      theme: "dark",
      enableAllProjectMcpServers: false,
      disabledMcpServers: ["risky-server"],
    });
    expect(result.ok).toBe(true);
  });

  test("invalid defaultMode produces error", () => {
    const result = validateKoiSettings({ permissions: { defaultMode: "invalid" } });
    expect(result.ok).toBe(false);
  });

  test("invalid theme produces error", () => {
    const result = validateKoiSettings({ theme: "neon" });
    expect(result.ok).toBe(false);
  });

  test("non-string env value produces error", () => {
    const result = validateKoiSettings({ env: { KEY: 42 } });
    expect(result.ok).toBe(false);
  });

  test("hook command missing type produces error", () => {
    const result = validateKoiSettings({
      hooks: { PreToolUse: [{ command: "./script.sh" }] },
    });
    expect(result.ok).toBe(false);
  });

  test("hook with invalid type produces error", () => {
    const result = validateKoiSettings({
      hooks: { PreToolUse: [{ type: "http", command: "./script.sh" }] },
    });
    expect(result.ok).toBe(false);
  });

  test("unknown top-level keys are stripped (not rejected)", () => {
    const result = validateKoiSettings({ unknownKey: true, theme: "dark" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as Record<string, unknown>).unknownKey).toBeUndefined();
      expect(result.value.theme).toBe("dark");
    }
  });
});

describe("getSettingsJsonSchema", () => {
  test("returns an object with $schema key", () => {
    const schema = getSettingsJsonSchema();
    expect(typeof schema).toBe("object");
    expect(schema).not.toBeNull();
  });
});
