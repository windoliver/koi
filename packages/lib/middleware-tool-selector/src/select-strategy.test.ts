import { describe, expect, test } from "bun:test";
import type { ToolDescriptor } from "@koi/core";
import { createKeywordSelectTools, createTagSelectTools } from "./select-strategy.js";

function tool(name: string, description: string, tags?: readonly string[]): ToolDescriptor {
  return tags === undefined
    ? { name, description, inputSchema: {} }
    : { name, description, inputSchema: {}, tags };
}

describe("createKeywordSelectTools", () => {
  test("scores tools by keyword overlap and sorts by descending score", async () => {
    const select = createKeywordSelectTools();
    const tools = [
      tool("file_read", "Read files from disk"),
      tool("json_parse", "Parse JSON content"),
      tool("shell_exec", "Execute shell commands"),
    ];
    const result = await select("please read config file then parse json", tools);
    // file_read scores 2 ("read", "file"), json_parse scores 2 ("parse", "json"),
    // shell_exec 0 — sorted by score desc; ties preserve relative order.
    expect(result).toEqual(["file_read", "json_parse"]);
  });

  test("drops tools with score 0", async () => {
    const select = createKeywordSelectTools();
    const tools = [tool("foo", "alpha"), tool("bar", "beta")];
    const result = await select("nothing matches here", tools);
    expect(result).toEqual([]);
  });

  test("returns all tool names in input order when query has no scoreable terms", async () => {
    const select = createKeywordSelectTools();
    const tools = [tool("a", "x"), tool("b", "y")];
    // Terms must be > 2 chars; "a b c" filters to nothing scoreable.
    const result = await select("a b c", tools);
    expect(result).toEqual(["a", "b"]);
  });

  test("matching is case-insensitive", async () => {
    const select = createKeywordSelectTools();
    const tools = [tool("Deploy", "Ship the App")];
    const result = await select("DEPLOY", tools);
    expect(result).toEqual(["Deploy"]);
  });
});

describe("createTagSelectTools", () => {
  test("includes only tools that carry every includeTag (AND semantics)", async () => {
    const select = createTagSelectTools(["coding", "math"], undefined);
    const tools = [
      tool("calc", "math tool", ["coding", "math"]),
      tool("file_read", "file tool", ["coding", "filesystem"]),
      tool("rng", "random", ["math"]),
    ];
    const result = await select("ignored", tools);
    expect(result).toEqual(["calc"]);
  });

  test("excludes tools that carry any excludeTag (ANY semantics)", async () => {
    const select = createTagSelectTools(undefined, ["dangerous"]);
    const tools = [
      tool("safe", "safe op", ["coding"]),
      tool("rm_rf", "destructive", ["filesystem", "dangerous"]),
      tool("untagged", "no tags"),
    ];
    const result = await select("ignored", tools);
    expect(result).toEqual(["safe", "untagged"]);
  });

  test("drops untagged tools when an include filter is active", async () => {
    const select = createTagSelectTools(["coding"], undefined);
    const tools = [tool("with_tag", "x", ["coding"]), tool("no_tag", "y")];
    const result = await select("ignored", tools);
    expect(result).toEqual(["with_tag"]);
  });

  test("combines include and exclude — include first, then exclude", async () => {
    const select = createTagSelectTools(["coding"], ["dangerous"]);
    const tools = [
      tool("file_read", "x", ["coding", "filesystem"]),
      tool("shell_exec", "x", ["coding", "dangerous"]),
      tool("calc", "x", ["coding", "math"]),
      tool("web_search", "x", ["research"]),
    ];
    const result = await select("ignored", tools);
    expect(result).toEqual(["file_read", "calc"]);
  });

  test("passes everything through when both filters are undefined", async () => {
    const select = createTagSelectTools(undefined, undefined);
    const tools = [tool("a", "x"), tool("b", "y", ["foo"])];
    const result = await select("ignored", tools);
    expect(result).toEqual(["a", "b"]);
  });

  test("treats empty-array filters as no filter", async () => {
    const select = createTagSelectTools([], []);
    const tools = [tool("a", "x"), tool("b", "y", ["foo"])];
    const result = await select("ignored", tools);
    expect(result).toEqual(["a", "b"]);
  });

  test("ignores the query argument", async () => {
    const select = createTagSelectTools(["coding"], undefined);
    const tools = [tool("a", "x", ["coding"])];
    const r1 = await select("alpha", tools);
    const r2 = await select("beta", tools);
    expect(r1).toEqual(r2);
  });
});
