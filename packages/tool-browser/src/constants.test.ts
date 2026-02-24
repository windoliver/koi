import { describe, expect, test } from "bun:test";
import { BROWSER_SYSTEM_PROMPT } from "./constants.js";

describe("BROWSER_SYSTEM_PROMPT", () => {
  test("is a non-empty string", () => {
    expect(typeof BROWSER_SYSTEM_PROMPT).toBe("string");
    expect(BROWSER_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  test("contains browser_snapshot instruction", () => {
    expect(BROWSER_SYSTEM_PROMPT).toContain("browser_snapshot");
  });

  test("contains snapshotId guidance", () => {
    expect(BROWSER_SYSTEM_PROMPT).toContain("snapshotId");
  });

  test("contains STALE_REF error code", () => {
    expect(BROWSER_SYSTEM_PROMPT).toContain("STALE_REF");
  });

  test("contains INTERNAL error code for page crash scenario", () => {
    expect(BROWSER_SYSTEM_PROMPT).toContain("INTERNAL");
  });

  test("contains snapshot-act-snapshot loop guidance", () => {
    expect(BROWSER_SYSTEM_PROMPT).toContain("Re-snapshot");
  });
});
