import { describe, expect, test } from "bun:test";
import { interpolateEnv, loadConfig, loadConfigFromString } from "./loader.js";

// ---------------------------------------------------------------------------
// interpolateEnv
// ---------------------------------------------------------------------------

describe("interpolateEnv", () => {
  test("replaces ${VAR} with env value", () => {
    const result = interpolateEnv("hello ${NAME}", { NAME: "world" });
    expect(result).toBe("hello world");
  });

  test("replaces ${VAR:-default} with env value when set", () => {
    const result = interpolateEnv("${PORT:-3000}", { PORT: "8080" });
    expect(result).toBe("8080");
  });

  test("uses default when env var is unset", () => {
    const result = interpolateEnv("${PORT:-3000}", {});
    expect(result).toBe("3000");
  });

  test("replaces with empty string when unset and no default", () => {
    const result = interpolateEnv("${MISSING}", {});
    expect(result).toBe("");
  });

  test("handles multiple interpolations", () => {
    const result = interpolateEnv("${A}-${B}", { A: "x", B: "y" });
    expect(result).toBe("x-y");
  });

  test("does not replace non-matching patterns", () => {
    expect(interpolateEnv("$NOT_A_MATCH", {})).toBe("$NOT_A_MATCH");
  });
});

// ---------------------------------------------------------------------------
// loadConfigFromString (YAML)
// ---------------------------------------------------------------------------

describe("loadConfigFromString (YAML)", () => {
  test("parses valid YAML", () => {
    const yaml = "logLevel: info\nlimits:\n  maxTurns: 25\n";
    const result = loadConfigFromString(yaml, "koi.yaml");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.logLevel).toBe("info");
    }
  });

  test("interpolates env vars in YAML", () => {
    const yaml = "logLevel: ${LOG_LEVEL:-warn}\n";
    const result = loadConfigFromString(yaml, "koi.yaml", {
      env: { LOG_LEVEL: "debug" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.logLevel).toBe("debug");
    }
  });

  test("returns error for invalid YAML", () => {
    const result = loadConfigFromString("{ bad yaml:", "koi.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("YAML");
    }
  });

  test("returns error for array top-level", () => {
    const result = loadConfigFromString("- item1\n- item2\n", "koi.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("plain object");
    }
  });

  test("returns error for scalar top-level", () => {
    const result = loadConfigFromString("42", "koi.yaml");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadConfigFromString (JSON)
// ---------------------------------------------------------------------------

describe("loadConfigFromString (JSON)", () => {
  test("parses valid JSON", () => {
    const json = '{"logLevel": "info"}';
    const result = loadConfigFromString(json, "koi.json");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.logLevel).toBe("info");
    }
  });

  test("interpolates env vars in JSON", () => {
    const json = '{"apiKey": "${API_KEY:-none}"}';
    const result = loadConfigFromString(json, "koi.json", {
      env: { API_KEY: "secret123" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.apiKey).toBe("secret123");
    }
  });

  test("returns error for invalid JSON", () => {
    const result = loadConfigFromString("{bad}", "koi.json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("JSON");
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfig (async, file I/O)
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  test("returns NOT_FOUND for nonexistent file", async () => {
    const result = await loadConfig("/tmp/koi-test-does-not-exist.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("processes $include directives from file", async () => {
    const dir = "/tmp/koi-loader-include-test";
    await Bun.write(`${dir}/extras.yaml`, "extra: included\n");
    await Bun.write(`${dir}/main.yaml`, "$include: extras.yaml\nlogLevel: debug\n");

    const result = await loadConfig(`${dir}/main.yaml`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.logLevel).toBe("debug");
      expect(result.value.extra).toBe("included");
      expect(result.value.$include).toBeUndefined();
    }
  });
});
