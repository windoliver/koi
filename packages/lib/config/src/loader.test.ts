import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpolateEnv, loadConfig, loadConfigFromString } from "./loader.js";

describe("interpolateEnv", () => {
  test(`replaces \${VAR} with env value`, () => {
    const result = interpolateEnv(`level: \${LOG_LEVEL}`, { LOG_LEVEL: "debug" });
    expect(result).toBe("level: debug");
  });

  test(`replaces \${VAR:-default} with env value when set`, () => {
    const result = interpolateEnv(`level: \${LOG_LEVEL:-info}`, { LOG_LEVEL: "debug" });
    expect(result).toBe("level: debug");
  });

  test("uses default when env var is unset", () => {
    const result = interpolateEnv(`level: \${LOG_LEVEL:-info}`, {});
    expect(result).toBe("level: info");
  });

  test("uses default when env var is empty string", () => {
    const result = interpolateEnv(`level: \${LOG_LEVEL:-info}`, { LOG_LEVEL: "" });
    expect(result).toBe("level: info");
  });

  test("replaces with empty string when no default and var unset", () => {
    const result = interpolateEnv(`level: \${LOG_LEVEL}`, {});
    expect(result).toBe("level: ");
  });

  test("handles multiple variables", () => {
    const result = interpolateEnv(`\${A} and \${B:-two}`, { A: "one" });
    expect(result).toBe("one and two");
  });
});

describe("loadConfigFromString", () => {
  test("parses YAML content", () => {
    const result = loadConfigFromString("logLevel: info\nmaxTurns: 25\n", "config.yaml");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ logLevel: "info", maxTurns: 25 });
    }
  });

  test("parses JSON content", () => {
    const result = loadConfigFromString('{"logLevel": "info"}', "config.json");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ logLevel: "info" });
    }
  });

  test("interpolates env vars before parsing", () => {
    const result = loadConfigFromString(`logLevel: \${LOG:-info}\n`, "config.yaml", {
      env: { LOG: "debug" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ logLevel: "debug" });
    }
  });

  test("returns error for non-object YAML", () => {
    const result = loadConfigFromString("- item1\n- item2\n", "config.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("returns error for invalid YAML syntax", () => {
    const result = loadConfigFromString(":\n  :\n    bad: {{{\n", "config.yaml");
    expect(result.ok).toBe(false);
  });
});

describe("loadConfig", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "koi-loader-test-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("loads and parses a YAML file", async () => {
    const filePath = join(tempDir, "simple.yaml");
    writeFileSync(filePath, "logLevel: info\n");
    const result = await loadConfig(filePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ logLevel: "info" });
    }
  });

  test("returns NOT_FOUND for missing file", async () => {
    const result = await loadConfig(join(tempDir, "nope.yaml"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("processes $include directives", async () => {
    const basePath = join(tempDir, "base-load.yaml");
    writeFileSync(basePath, "logLevel: info\nmaxTurns: 25\n");
    const mainPath = join(tempDir, "main-load.yaml");
    writeFileSync(mainPath, `$include:\n  - base-load.yaml\nlogLevel: debug\n`);
    const result = await loadConfig(mainPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ logLevel: "debug", maxTurns: 25 });
    }
  });
});
