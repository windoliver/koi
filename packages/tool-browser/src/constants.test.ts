import { describe, expect, test } from "bun:test";
import { BROWSER_SKILL, BROWSER_SKILL_NAME, BROWSER_SYSTEM_PROMPT } from "./constants.js";

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

describe("BROWSER_SKILL", () => {
  test("has correct name", () => {
    expect(BROWSER_SKILL.name).toBe(BROWSER_SKILL_NAME);
  });

  test("has non-empty description and content", () => {
    expect(BROWSER_SKILL.description.length).toBeGreaterThan(0);
    expect(BROWSER_SKILL.content.length).toBeGreaterThan(0);
  });

  test("content covers snapshot-first workflow", () => {
    expect(BROWSER_SKILL.content).toContain("browser_snapshot");
    expect(BROWSER_SKILL.content).toContain("snapshotId");
  });

  test("content covers form filling guidance", () => {
    expect(BROWSER_SKILL.content).toContain("browser_fill_form");
    expect(BROWSER_SKILL.content).toContain("browser_type");
  });

  test("content covers wait strategies", () => {
    expect(BROWSER_SKILL.content).toContain("browser_wait");
  });

  test("content covers tab management", () => {
    expect(BROWSER_SKILL.content).toContain("browser_tab_focus");
    expect(BROWSER_SKILL.content).toContain("browser_tab_close");
  });

  test("content covers trust tier awareness for evaluate", () => {
    expect(BROWSER_SKILL.content).toContain("browser_evaluate");
    expect(BROWSER_SKILL.content).toContain("promoted");
  });

  test("has browser and best-practices tags", () => {
    expect(BROWSER_SKILL.tags).toContain("browser");
    expect(BROWSER_SKILL.tags).toContain("best-practices");
  });
});
