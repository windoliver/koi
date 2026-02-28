import { describe, expect, test } from "bun:test";
import { resolveProfile } from "./resolve-profile.js";
import { TOOL_PROFILES } from "./tool-profiles.js";

describe("resolveProfile", () => {
  test("profile: 'coding' returns the coding tool set", () => {
    const result = resolveProfile({ profile: "coding" });
    expect(result.toolNames).toEqual(TOOL_PROFILES.coding);
    expect(result.isFullProfile).toBe(false);
  });

  test("profile: 'coding' with include adds extra tools", () => {
    const result = resolveProfile({ profile: "coding", include: ["extra_tool"] });
    expect(result.toolNames).toContain("extra_tool");
    expect(result.toolNames.length).toBe(TOOL_PROFILES.coding.length + 1);
  });

  test("profile: 'coding' with exclude removes tools", () => {
    const result = resolveProfile({ profile: "coding", exclude: ["shell_exec"] });
    expect(result.toolNames).not.toContain("shell_exec");
    expect(result.toolNames.length).toBe(TOOL_PROFILES.coding.length - 1);
  });

  test("include does not create duplicates", () => {
    const result = resolveProfile({ profile: "coding", include: ["file_read"] });
    const fileReadCount = result.toolNames.filter((n) => n === "file_read").length;
    expect(fileReadCount).toBe(1);
    expect(result.toolNames.length).toBe(TOOL_PROFILES.coding.length);
  });

  test("excluding all tools yields empty set", () => {
    const result = resolveProfile({
      profile: "coding",
      exclude: [...TOOL_PROFILES.coding],
    });
    expect(result.toolNames).toEqual([]);
    expect(result.isFullProfile).toBe(false);
  });

  test("profile: 'full' returns isFullProfile=true with empty toolNames", () => {
    const result = resolveProfile({ profile: "full" });
    expect(result.isFullProfile).toBe(true);
    expect(result.toolNames).toEqual([]);
  });

  test("profile: 'auto' with tier 'minimal' resolves to minimal profile", () => {
    const result = resolveProfile({ profile: "auto", tier: "minimal" });
    expect(result.toolNames).toEqual(TOOL_PROFILES.minimal);
  });

  test("profile: 'auto' with no tier resolves to coding (standard default)", () => {
    const result = resolveProfile({ profile: "auto" });
    expect(result.toolNames).toEqual(TOOL_PROFILES.coding);
    expect(result.isFullProfile).toBe(false);
  });

  test("tier cap truncates tools beyond maxTools", () => {
    // coding has 7 tools; minimal tier caps at 5
    const result = resolveProfile({ profile: "coding", tier: "minimal" });
    expect(result.toolNames.length).toBeLessThanOrEqual(5);
  });

  test("nonexistent include/exclude names are no-ops", () => {
    const result = resolveProfile({
      profile: "minimal",
      include: ["nonexistent_tool"],
      exclude: ["also_nonexistent"],
    });
    // include adds it (it's just a name), exclude has nothing to remove from base
    expect(result.toolNames).toContain("nonexistent_tool");
    expect(result.toolNames.length).toBe(TOOL_PROFILES.minimal.length + 1);
  });

  test("profile: 'auto' with tier 'full' resolves to full profile", () => {
    const result = resolveProfile({ profile: "auto", tier: "full" });
    expect(result.isFullProfile).toBe(true);
  });

  test("profile: 'auto' with tier 'advanced' resolves to coding profile", () => {
    const result = resolveProfile({ profile: "auto", tier: "advanced" });
    expect(result.toolNames).toEqual(TOOL_PROFILES.coding);
  });
});
