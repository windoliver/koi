import { describe, expect, test } from "bun:test";
import type { ToolsetDefinition, ToolsetRegistry } from "@koi/core";
import type { MergeRegistriesOptions } from "./index.js";
import { createBuiltinRegistry, mergeRegistries, resolveToolset } from "./index.js";

function makeRegistry(defs: readonly ToolsetDefinition[]): ToolsetRegistry {
  return new Map(defs.map((d) => [d.name, d]));
}

describe("resolveToolset", () => {
  test("resolves a simple toolset to allowlist mode", () => {
    const reg = makeRegistry([
      { name: "web", description: "Web tools", tools: ["web_search", "web_fetch"], includes: [] },
    ]);
    const result = resolveToolset("web", reg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("allowlist");
    if (result.value.mode !== "allowlist") return;
    expect([...result.value.tools].sort()).toEqual(["web_fetch", "web_search"]);
  });

  test("resolves includes recursively", () => {
    const reg = makeRegistry([
      {
        name: "reading",
        description: "Read tools",
        tools: ["Read", "Glob"],
        includes: [],
      },
      {
        name: "researcher",
        description: "Researcher",
        tools: ["web_search"],
        includes: ["reading"],
      },
    ]);
    const result = resolveToolset("researcher", reg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("allowlist");
    if (result.value.mode !== "allowlist") return;
    expect([...result.value.tools].sort()).toEqual(["Glob", "Read", "web_search"]);
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
    expect(result.value.mode).toBe("allowlist");
    if (result.value.mode !== "allowlist") return;
    expect([...result.value.tools].sort()).toEqual(["tool_x", "tool_y", "tool_z"]);
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

  test("wildcard * resolves to mode:all, not an allowlist entry", () => {
    const reg = makeRegistry([
      { name: "developer", description: "All tools", tools: ["*"], includes: [] },
    ]);
    const result = resolveToolset("developer", reg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("all");
    // mode:all has no tools property — caller cannot accidentally filter on "*"
    expect("tools" in result.value).toBe(false);
  });

  test("rejects * mixed with other tools in the same preset", () => {
    const reg = makeRegistry([
      { name: "bad", description: "Mixed", tools: ["*", "web_fetch"], includes: [] },
    ]);
    const result = resolveToolset("bad", reg);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects * in a preset that also has includes", () => {
    const reg = makeRegistry([
      { name: "base", description: "Base", tools: ["web_fetch"], includes: [] },
      { name: "bad", description: "Mixed", tools: ["*"], includes: ["base"] },
    ]);
    const result = resolveToolset("bad", reg);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects wildcard inherited through includes — restricted preset cannot silently become mode:all", () => {
    const reg = makeRegistry([
      { name: "developer", description: "All tools", tools: ["*"], includes: [] },
      {
        name: "sneaky",
        description: "Looks restricted",
        tools: ["fs_read"],
        includes: ["developer"],
      },
    ]);
    const result = resolveToolset("sneaky", reg);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.context).toMatchObject({ name: "sneaky", include: "developer" });
  });

  test("rejects wildcard inherited transitively through multi-level includes", () => {
    const reg = makeRegistry([
      { name: "developer", description: "All", tools: ["*"], includes: [] },
      { name: "mid", description: "Mid", tools: ["fs_read"], includes: ["developer"] },
      { name: "outer", description: "Outer", tools: ["web_fetch"], includes: ["mid"] },
    ]);
    const result = resolveToolset("outer", reg);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects resolution that exceeds depth limit", () => {
    // Build a 55-level deep chain (beyond MAX_DEPTH=50)
    const defs: ToolsetDefinition[] = [];
    for (let i = 0; i < 55; i++) {
      defs.push({
        name: `level_${i}`,
        description: "",
        tools: [`tool_${i}`],
        includes: i < 54 ? [`level_${i + 1}`] : [],
      });
    }
    const reg = makeRegistry(defs);
    const result = resolveToolset("level_0", reg);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });

  test("shared subgraph resolved only once — shared sibling includes deduplicate tools", () => {
    const reg = makeRegistry([
      { name: "shared", description: "Shared", tools: ["tool_x"], includes: [] },
      { name: "a", description: "A", tools: ["tool_a"], includes: ["shared"] },
      { name: "b", description: "B", tools: ["tool_b"], includes: ["shared"] },
      { name: "combo", description: "Combo", tools: [], includes: ["a", "b"] },
    ]);
    const result = resolveToolset("combo", reg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("allowlist");
    if (result.value.mode !== "allowlist") return;
    // tool_x should appear exactly once despite being reachable via both a and b
    expect([...result.value.tools].filter((t) => t === "tool_x")).toHaveLength(1);
    expect([...result.value.tools].sort()).toEqual(["tool_a", "tool_b", "tool_x"]);
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

  test("safe preset is read-only — no Bash, Write, Edit, or fs_write/fs_edit", () => {
    const reg = createBuiltinRegistry();
    const result = resolveToolset("safe", reg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("allowlist");
    if (result.value.mode !== "allowlist") return;
    for (const tool of result.value.tools) {
      expect(tool).not.toMatch(/^Bash$|^Write$|^Edit$|fs_write|fs_edit/);
    }
    expect(result.value.tools).toContain("fs_read");
    expect(result.value.tools).toContain("web_fetch");
  });

  test("developer preset resolves to mode:all", () => {
    const reg = createBuiltinRegistry();
    const result = resolveToolset("developer", reg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("all");
  });

  test("researcher preset includes glob and grep but no write/edit tools", () => {
    const reg = createBuiltinRegistry();
    const result = resolveToolset("researcher", reg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("allowlist");
    if (result.value.mode !== "allowlist") return;
    expect(result.value.tools).toContain("Glob");
    expect(result.value.tools).toContain("Grep");
    expect(result.value.tools).toContain("fs_read");
    expect(result.value.tools).toContain("web_fetch");
    for (const tool of result.value.tools) {
      expect(tool).not.toMatch(/^Bash$|^Write$|^Edit$|fs_write|fs_edit/);
    }
  });

  test("minimal preset contains only ask tool", () => {
    const reg = createBuiltinRegistry();
    const result = resolveToolset("minimal", reg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("allowlist");
    if (result.value.mode !== "allowlist") return;
    expect(result.value.tools).toEqual(["AskUserQuestion"]);
  });

  test("safe tools are a subset of researcher tools", () => {
    const reg = createBuiltinRegistry();
    const safeResult = resolveToolset("safe", reg);
    const researcherResult = resolveToolset("researcher", reg);
    expect(safeResult.ok).toBe(true);
    expect(researcherResult.ok).toBe(true);
    if (!safeResult.ok || !researcherResult.ok) return;
    if (safeResult.value.mode !== "allowlist" || researcherResult.value.mode !== "allowlist")
      return;
    for (const tool of safeResult.value.tools) {
      expect(researcherResult.value.tools).toContain(tool);
    }
  });

  test("builtin registry definitions are deep-frozen — tools array cannot be mutated at runtime", () => {
    const reg = createBuiltinRegistry();
    const safe = reg.get("safe");
    expect(safe).toBeDefined();
    if (!safe) return;
    expect(Object.isFrozen(safe)).toBe(true);
    expect(Object.isFrozen(safe.tools)).toBe(true);
    expect(Object.isFrozen(safe.includes)).toBe(true);
    expect(() => {
      (safe.tools as string[]).push("Bash");
    }).toThrow();
  });

  test("builtin registry supports all ReadonlyMap iteration methods", () => {
    const reg = createBuiltinRegistry();
    const expected = ["developer", "minimal", "researcher", "safe"];

    const namesFromForEach: string[] = [];
    reg.forEach((_def, name) => {
      namesFromForEach.push(name);
    });
    expect(namesFromForEach.sort()).toEqual(expected);

    expect([...reg.keys()].sort()).toEqual(expected);
    expect([...reg.values()].map((d) => d.name).sort()).toEqual(expected);
    expect([...reg.entries()].map(([k]) => k).sort()).toEqual(expected);

    const namesFromIterator: string[] = [];
    for (const [name] of reg) {
      namesFromIterator.push(name);
    }
    expect(namesFromIterator.sort()).toEqual(expected);
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
    const merged = mergeRegistries([base, custom]);
    expect(merged.has("web")).toBe(true);
    expect(merged.has("custom")).toBe(true);
  });

  test("throws on name collision by default — silent shadowing is not allowed", () => {
    const first = makeRegistry([
      { name: "web", description: "First", tools: ["tool_a"], includes: [] },
    ]);
    const second = makeRegistry([
      { name: "web", description: "Second", tools: ["tool_b"], includes: [] },
    ]);
    expect(() => mergeRegistries([first, second])).toThrow(/duplicate toolset name "web"/);
  });

  test("later registry wins on name collision when allowOverrides is true", () => {
    const first = makeRegistry([
      { name: "web", description: "First", tools: ["tool_a"], includes: [] },
    ]);
    const second = makeRegistry([
      { name: "web", description: "Second", tools: ["tool_b"], includes: [] },
    ]);
    const opts: MergeRegistriesOptions = { allowOverrides: true };
    const merged = mergeRegistries([first, second], opts);
    expect(merged.get("web")?.tools).toEqual(["tool_b"]);
  });

  test("merging zero registries returns empty map", () => {
    const merged = mergeRegistries([]);
    expect(merged.size).toBe(0);
  });
});
