import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { expandEnvVars, expandEnvVarsInRecord } from "./env.js";

describe("expandEnvVars", () => {
  beforeEach(() => {
    process.env.TEST_VAR = "hello";
    process.env.TEST_EMPTY = "";
  });

  afterEach(() => {
    delete process.env.TEST_VAR;
    delete process.env.TEST_EMPTY;
    delete process.env.TEST_TEMP;
  });

  test(`expands \${VAR}`, () => {
    const { expanded, missing } = expandEnvVars(`value is \${TEST_VAR}`);
    expect(expanded).toBe("value is hello");
    expect(missing).toHaveLength(0);
  });

  test("expands multiple vars", () => {
    process.env.TEST_TEMP = "world";
    const { expanded } = expandEnvVars(`\${TEST_VAR} \${TEST_TEMP}`);
    expect(expanded).toBe("hello world");
  });

  test("uses default value when var is missing", () => {
    const { expanded, missing } = expandEnvVars(`\${NONEXISTENT:-fallback}`);
    expect(expanded).toBe("fallback");
    expect(missing).toHaveLength(0);
  });

  test("uses default value when var is empty", () => {
    const { expanded } = expandEnvVars(`\${TEST_EMPTY:-default}`);
    expect(expanded).toBe("default");
  });

  test("uses env value over default when set", () => {
    const { expanded } = expandEnvVars(`\${TEST_VAR:-default}`);
    expect(expanded).toBe("hello");
  });

  test("reports missing vars with no default", () => {
    const { expanded, missing } = expandEnvVars(`\${NONEXISTENT_VAR}`);
    expect(expanded).toBe(`\${NONEXISTENT_VAR}`); // preserved for debugging
    expect(missing).toEqual(["NONEXISTENT_VAR"]);
  });

  test("passes through strings without vars", () => {
    const { expanded, missing } = expandEnvVars("no vars here");
    expect(expanded).toBe("no vars here");
    expect(missing).toHaveLength(0);
  });

  test("handles empty default", () => {
    const { expanded } = expandEnvVars(`\${NONEXISTENT:-}`);
    expect(expanded).toBe("");
  });

  test("handles default with special chars", () => {
    const { expanded } = expandEnvVars(`\${NONEXISTENT:-https://example.com}`);
    expect(expanded).toBe("https://example.com");
  });

  test("handles default containing :-", () => {
    const { expanded } = expandEnvVars(`\${NONEXISTENT:-a:-b}`);
    expect(expanded).toBe("a:-b");
  });
});

describe("expandEnvVarsInRecord", () => {
  beforeEach(() => {
    process.env.TEST_KEY = "secret";
  });

  afterEach(() => {
    delete process.env.TEST_KEY;
  });

  test("expands all values in record", () => {
    const { expanded, missing } = expandEnvVarsInRecord({
      Authorization: `Bearer \${TEST_KEY}`,
      "X-Custom": "static",
    });
    expect(expanded.Authorization).toBe("Bearer secret");
    expect(expanded["X-Custom"]).toBe("static");
    expect(missing).toHaveLength(0);
  });

  test("collects missing vars across all values", () => {
    const { missing } = expandEnvVarsInRecord({
      a: `\${MISSING_A}`,
      b: `\${MISSING_B}`,
    });
    expect(missing).toEqual(["MISSING_A", "MISSING_B"]);
  });
});
