import { describe, expect, test } from "bun:test";
import { validateToolSelectorConfig } from "./config.js";

const noop = async (): Promise<readonly string[]> => [];

describe("validateToolSelectorConfig", () => {
  test("accepts a minimal valid config (selectTools only)", () => {
    const result = validateToolSelectorConfig({ selectTools: noop });
    expect(result.ok).toBe(true);
  });

  test("rejects non-object config", () => {
    expect(validateToolSelectorConfig(null).ok).toBe(false);
    expect(validateToolSelectorConfig(undefined).ok).toBe(false);
    expect(validateToolSelectorConfig("string").ok).toBe(false);
  });

  test("rejects missing or non-function selectTools", () => {
    const r1 = validateToolSelectorConfig({});
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.message).toContain("selectTools");

    const r2 = validateToolSelectorConfig({ selectTools: "no" });
    expect(r2.ok).toBe(false);
  });

  test("rejects non-string-array alwaysInclude", () => {
    const r = validateToolSelectorConfig({ selectTools: noop, alwaysInclude: [1, 2] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("alwaysInclude");
  });

  test("rejects non-positive-integer maxTools", () => {
    expect(validateToolSelectorConfig({ selectTools: noop, maxTools: 0 }).ok).toBe(false);
    expect(validateToolSelectorConfig({ selectTools: noop, maxTools: -1 }).ok).toBe(false);
    expect(validateToolSelectorConfig({ selectTools: noop, maxTools: 1.5 }).ok).toBe(false);
    expect(validateToolSelectorConfig({ selectTools: noop, maxTools: 10 }).ok).toBe(true);
  });

  test("rejects negative or non-integer minTools but accepts 0", () => {
    expect(validateToolSelectorConfig({ selectTools: noop, minTools: -1 }).ok).toBe(false);
    expect(validateToolSelectorConfig({ selectTools: noop, minTools: 1.5 }).ok).toBe(false);
    expect(validateToolSelectorConfig({ selectTools: noop, minTools: 0 }).ok).toBe(true);
  });

  test("rejects non-function extractQuery / onError", () => {
    expect(validateToolSelectorConfig({ selectTools: noop, extractQuery: "no" }).ok).toBe(false);
    expect(validateToolSelectorConfig({ selectTools: noop, onError: 42 }).ok).toBe(false);
  });
});
