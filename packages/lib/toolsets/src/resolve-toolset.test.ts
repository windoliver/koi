import { describe, expect, test } from "bun:test";
import type { ToolsetDefinition, ToolsetRegistry } from "@koi/core";
import { createBuiltinRegistry, mergeRegistries, resolveToolset } from "./index.js";

function makeRegistry(defs: readonly ToolsetDefinition[]): ToolsetRegistry {
  return new Map(defs.map((d) => [d.name, d]));
}

describe("resolveToolset", () => {
  test("resolves a simple toolset with no includes", () => {
    const reg = makeRegistry([
      { name: "web", description: "Web tools", tools: ["web_search", "web_fetch"], includes: [] },
    ]);
    const result = resolveToolset("web", reg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value].sort()).toEqual(["web_fetch", "web_search"]);
  });

  test("resolves includes recursively", () => {
    const reg = makeRegistry([
      {
        name: "memory",
        description: "Memory",
        tools: ["memory_read", "memory_write"],
        includes: [],
      },
      { name: "researcher", description: "Researcher", tools: ["glob"], includes: ["memory"] },
    ]);
    const result = resolveToolset("researcher", reg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value].sort()).toEqual(["glob", "memory_read", "memory_write"]);
  });

  test("deduplicates tools appearing in multiple toolsets", () => {
    const reg = makeRegistry([
      { name: "a", description: "", tools: ["tool_x", "tool_y"], includes: [] },
      { name: "b", description: "", tools: ["tool_y", "tool_z"], includes: [] },
      { name: "combo", description: "", tools: [], includes: ["a", "b"] },
    ]);
    const result = resolveToolset("combo", reg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value].sort()).toEqual(["tool_x", "tool_y", "tool_z"]);
  });

  test("returns error for unknown toolset name", () => {
    const reg = makeRegistry([]);
    const result = resolveToolset("missing", reg);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.context).toMatchObject({ name: "missing" });
  });

  test("detects direct cycle (a → a)", () => {
    const reg = makeRegistry([{ name: "a", description: "", tools: [], includes: ["a"] }]);
    const result = resolveToolset("a", reg);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("detects indirect cycle (a → b → a)", () => {
    const reg = makeRegistry([
      { name: "a", description: "", tools: ["tool_a"], includes: ["b"] },
      { name: "b", description: "", tools: ["tool_b"], includes: ["a"] },
    ]);
    const result = resolveToolset("a", reg);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("wildcard * passes through as-is", () => {
    const reg = makeRegistry([
      { name: "developer", description: "All tools", tools: ["*"], includes: [] },
    ]);
    const result = resolveToolset("developer", reg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value]).toEqual(["*"]);
  });
});

describe("createBuiltinRegistry", () => {
  test("contains all four built-in presets", () => {
    const reg = createBuiltinRegistry();
    expect(reg.has("safe")).toBe(true);
    expect(reg.has("developer")).toBe(true);
    expect(reg.has("researcher")).toBe(true);
    expect(reg.has("minimal")).toBe(true);
  });

  test("safe preset contains no bash or file-write tools", () => {
    const reg = createBuiltinRegistry();
    const result = resolveToolset("safe", reg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const tool of result.value) {
      expect(tool).not.toMatch(/bash|write_file|edit_file/);
    }
  });

  test("developer preset resolves to wildcard", () => {
    const reg = createBuiltinRegistry();
    const result = resolveToolset("developer", reg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.includes("*")).toBe(true);
  });

  test("minimal preset has fewer tools than researcher", () => {
    const reg = createBuiltinRegistry();
    const minimalResult = resolveToolset("minimal", reg);
    const researcherResult = resolveToolset("researcher", reg);
    expect(minimalResult.ok).toBe(true);
    expect(researcherResult.ok).toBe(true);
    if (!minimalResult.ok || !researcherResult.ok) return;
    expect(minimalResult.value.length).toBeLessThan(researcherResult.value.length);
  });

  test("researcher preset is superset of safe", () => {
    const reg = createBuiltinRegistry();
    const safeResult = resolveToolset("safe", reg);
    const researcherResult = resolveToolset("researcher", reg);
    expect(safeResult.ok).toBe(true);
    expect(researcherResult.ok).toBe(true);
    if (!safeResult.ok || !researcherResult.ok) return;
    for (const tool of safeResult.value) {
      expect(researcherResult.value).toContain(tool);
    }
  });
});

describe("mergeRegistries", () => {
  test("combines registries from multiple sources", () => {
    const base = makeRegistry([
      { name: "web", description: "Web", tools: ["web_search"], includes: [] },
    ]);
    const custom = makeRegistry([
      { name: "custom", description: "Custom", tools: ["my_tool"], includes: [] },
    ]);
    const merged = mergeRegistries(base, custom);
    expect(merged.has("web")).toBe(true);
    expect(merged.has("custom")).toBe(true);
  });

  test("later registry wins on name collision", () => {
    const first = makeRegistry([
      { name: "web", description: "First", tools: ["tool_a"], includes: [] },
    ]);
    const second = makeRegistry([
      { name: "web", description: "Second", tools: ["tool_b"], includes: [] },
    ]);
    const merged = mergeRegistries(first, second);
    expect(merged.get("web")?.tools).toEqual(["tool_b"]);
  });

  test("merging zero registries returns empty map", () => {
    const merged = mergeRegistries();
    expect(merged.size).toBe(0);
  });
});
