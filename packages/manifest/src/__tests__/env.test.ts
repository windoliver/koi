import { describe, expect, test } from "bun:test";
import { interpolateEnv } from "../env.js";

// Helper to build env-var reference strings without triggering Biome's noTemplateCurlyInString
function envRef(name: string, defaultVal?: string): string {
  return defaultVal !== undefined ? "$" + `{${name}:-${defaultVal}}` : "$" + `{${name}}`;
}

describe("interpolateEnv", () => {
  test("replaces variable with env value", () => {
    const result = interpolateEnv(`token: ${envRef("API_KEY")}`, { API_KEY: "sk-123" });
    expect(result).toBe("token: sk-123");
  });

  test("replaces multiple variables", () => {
    const result = interpolateEnv(`${envRef("HOST")}:${envRef("PORT")}`, {
      HOST: "localhost",
      PORT: "3000",
    });
    expect(result).toBe("localhost:3000");
  });

  test("uses default value when var is missing", () => {
    const result = interpolateEnv(`port: ${envRef("PORT", "8080")}`, {});
    expect(result).toBe("port: 8080");
  });

  test("uses env value over default when var exists", () => {
    const result = interpolateEnv(`port: ${envRef("PORT", "8080")}`, { PORT: "3000" });
    expect(result).toBe("port: 3000");
  });

  test("preserves empty string env value over default", () => {
    const result = interpolateEnv(`val: ${envRef("VAR", "fallback")}`, { VAR: "" });
    expect(result).toBe("val: ");
  });

  test("leaves string unchanged when no variables present", () => {
    const input = "name: my-agent\nversion: 1.0.0";
    const result = interpolateEnv(input, {});
    expect(result).toBe(input);
  });

  test("replaces unset var without default with empty string", () => {
    const result = interpolateEnv(`key: ${envRef("MISSING")}`, {});
    expect(result).toBe("key: ");
  });
});
