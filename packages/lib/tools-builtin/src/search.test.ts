import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolSummary } from "@koi/core";
import { isAttachResult } from "@koi/core";
import { createBuiltinSearchProvider } from "./builtin-search-provider.js";
import { createGlobTool } from "./glob-tool.js";
import { createGrepTool } from "./grep-tool.js";
import { createToolSearchTool } from "./tool-search-tool.js";

// ---------------------------------------------------------------------------
// Test fixture: temp directory with known files
// ---------------------------------------------------------------------------

const TMP = join(import.meta.dir, "__test-fixtures__");

const TMP_OUTSIDE = join(import.meta.dir, "__test-outside__");

beforeAll(() => {
  mkdirSync(join(TMP, "sub"), { recursive: true });
  // Create files with staggered writes so mtime ordering is deterministic.
  writeFileSync(join(TMP, "alpha.ts"), "export const a = 1;\n");
  writeFileSync(join(TMP, "beta.ts"), "export const b = 2;\nexport const bb = 22;\n");
  writeFileSync(join(TMP, "sub", "gamma.ts"), "export const g = 3;\n");
  writeFileSync(join(TMP, "readme.md"), "# Hello\n");

  // Symlink escape fixture: directory outside workspace linked inside
  mkdirSync(TMP_OUTSIDE, { recursive: true });
  writeFileSync(join(TMP_OUTSIDE, "secret.ts"), "export const secret = true;\n");
  try {
    symlinkSync(TMP_OUTSIDE, join(TMP, "escape-link"), "dir");
  } catch {
    // Symlink may already exist from prior run
  }

  // Large file for fallback skip test (> 1 MiB)
  writeFileSync(join(TMP, "huge.bin"), "x".repeat(1_100_000));
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(TMP_OUTSIDE, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Glob tool
// ---------------------------------------------------------------------------

describe("createGlobTool", () => {
  const tool = createGlobTool({ cwd: TMP });

  test("descriptor has correct shape", () => {
    expect(tool.descriptor.name).toBe("Glob");
    expect(tool.descriptor.description).toBeString();
    expect(tool.descriptor.inputSchema).toBeObject();
    expect(tool.origin).toBe("primordial");
  });

  test("matches files with glob pattern", async () => {
    const result = (await tool.execute({ pattern: "**/*.ts" })) as {
      readonly paths: readonly string[];
      readonly truncated: boolean;
    };
    expect(result.paths).toBeArray();
    expect(result.paths.length).toBe(3);
    expect(result.paths).toContain("alpha.ts");
    expect(result.paths).toContain("beta.ts");
    expect(result.paths).toContain(join("sub", "gamma.ts"));
    expect(result.truncated).toBe(false);
  });

  test("respects path parameter and returns workspace-relative paths", async () => {
    const result = (await tool.execute({
      pattern: "*.ts",
      path: join(TMP, "sub"),
    })) as { readonly paths: readonly string[] };
    expect(result.paths.length).toBe(1);
    // Path should be workspace-relative (sub/gamma.ts), not just gamma.ts
    expect(result.paths[0]).toBe(join("sub", "gamma.ts"));
  });

  test("returns empty paths for no matches", async () => {
    const result = (await tool.execute({ pattern: "**/*.xyz" })) as {
      readonly paths: readonly string[];
    };
    expect(result.paths).toEqual([]);
  });

  test("rejects empty pattern", async () => {
    const result = (await tool.execute({ pattern: "" })) as { readonly error: string };
    expect(result.error).toBeString();
  });

  test("rejects path that escapes workspace root", async () => {
    const result = (await tool.execute({
      pattern: "**/*.ts",
      path: "/etc",
    })) as { readonly error: string };
    expect(result.error).toContain("escapes");
  });

  test("rejects relative path traversal", async () => {
    const result = (await tool.execute({
      pattern: "**/*.ts",
      path: "../../etc",
    })) as { readonly error: string };
    expect(result.error).toContain("escapes");
  });

  test("rejects sibling path with same prefix", async () => {
    // If cwd is /foo/bar, then /foo/bar-evil should be rejected
    const tool2 = createGlobTool({ cwd: TMP });
    const result = (await tool2.execute({
      pattern: "**/*",
      path: `${TMP}-evil`,
    })) as { readonly error: string };
    expect(result.error).toContain("escapes");
  });

  test("rejects symlink that escapes workspace", async () => {
    const result = (await tool.execute({
      pattern: "**/*.ts",
      path: join(TMP, "escape-link"),
    })) as { readonly error: string };
    expect(result.error).toContain("outside the workspace");
  });

  test("rejects pattern with .. traversal", async () => {
    const result = (await tool.execute({ pattern: "../*.ts" })) as { readonly error: string };
    expect(result.error).toContain("..");
  });

  test("rejects absolute pattern", async () => {
    const result = (await tool.execute({ pattern: "/etc/**/*" })) as { readonly error: string };
    expect(result.error).toContain("absolute");
  });

  test("returns error for nonexistent in-workspace path", async () => {
    const result = (await tool.execute({
      pattern: "**/*.ts",
      path: join(TMP, "does-not-exist"),
    })) as { readonly error: string };
    expect(result.error).toBeString();
  });
});

// ---------------------------------------------------------------------------
// Grep tool
// ---------------------------------------------------------------------------

// Helper: extract result text from unified grep output
interface GrepOutput {
  readonly result: string;
  readonly mode: "rg" | "literal";
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}
function grepText(raw: unknown): string {
  if (typeof raw === "object" && raw !== null && "result" in raw) {
    return (raw as GrepOutput).result;
  }
  return String(raw);
}
function grepOutput(raw: unknown): GrepOutput {
  return raw as GrepOutput;
}

describe("createGrepTool", () => {
  const tool = createGrepTool({ cwd: TMP });

  test("descriptor has correct shape", () => {
    expect(tool.descriptor.name).toBe("Grep");
    expect(tool.descriptor.description).toBeString();
    expect(tool.descriptor.inputSchema).toBeObject();
    expect(tool.origin).toBe("primordial");
  });

  test("returns matching files in files_with_matches mode", async () => {
    const result = grepText(await tool.execute({ pattern: "export const" }));
    expect(result).toContain("alpha.ts");
    expect(result).toContain("beta.ts");
  });

  test("returns content lines in content mode", async () => {
    const result = grepText(
      await tool.execute({ pattern: "export const a", output_mode: "content" }),
    );
    expect(result).toContain("export const a = 1");
  });

  test("returns counts in count mode", async () => {
    const result = grepText(await tool.execute({ pattern: "export const", output_mode: "count" }));
    expect(result).toContain("beta.ts");
  });

  test("respects head_limit", async () => {
    const result = grepText(
      await tool.execute({
        pattern: "export const",
        output_mode: "content",
        head_limit: 1,
        glob: "*.ts",
      }),
    );
    const dataLines = result.trim().split("\n").filter(Boolean);
    expect(dataLines.length).toBe(1);
  });

  test("respects offset", async () => {
    const all = grepText(
      await tool.execute({
        pattern: "export const",
        output_mode: "content",
        head_limit: 0,
        glob: "*.ts",
      }),
    );
    const allLines = all.trim().split("\n").filter(Boolean);

    const withOffset = grepText(
      await tool.execute({
        pattern: "export const",
        output_mode: "content",
        offset: 1,
        head_limit: 0,
        glob: "*.ts",
      }),
    );
    const offsetLines = withOffset.trim().split("\n").filter(Boolean);

    expect(offsetLines.length).toBe(allLines.length - 1);
  });

  test("supports case-insensitive search", async () => {
    const result = grepText(
      await tool.execute({
        pattern: "EXPORT CONST",
        output_mode: "files_with_matches",
        "-i": true,
      }),
    );
    expect(result).toContain("alpha.ts");
  });

  test("supports glob filter", async () => {
    const result = grepText(await tool.execute({ pattern: "export const", glob: "*.md" }));
    expect(result.trim()).toBe("");
  });

  test("rejects empty pattern", async () => {
    const result = (await tool.execute({ pattern: "" })) as { readonly error: string };
    expect(result.error).toBeString();
  });

  test("rejects path that escapes workspace root", async () => {
    const result = (await tool.execute({
      pattern: "export",
      path: "/etc",
    })) as { readonly error: string };
    expect(result.error).toContain("escapes");
  });

  test("rejects relative path traversal", async () => {
    const result = (await tool.execute({
      pattern: "export",
      path: "../../../etc/passwd",
    })) as { readonly error: string };
    expect(result.error).toContain("escapes");
  });

  test("rejects sibling path with same prefix", async () => {
    const result = (await tool.execute({
      pattern: "export",
      path: `${TMP}-evil`,
    })) as { readonly error: string };
    expect(result.error).toContain("escapes");
  });

  test("rejects symlink that escapes workspace", async () => {
    const result = (await tool.execute({
      pattern: "secret",
      path: join(TMP, "escape-link"),
    })) as { readonly error: string };
    expect(result.error).toContain("outside the workspace");
  });

  test("rejects glob filter with .. traversal", async () => {
    const result = (await tool.execute({
      pattern: "export",
      glob: "../*.ts",
    })) as { readonly error: string };
    expect(result.error).toContain("..");
  });

  test("returns unified structured result", async () => {
    const out = grepOutput(await tool.execute({ pattern: "export const" }));
    expect(out.result).toBeString();
    expect(["rg", "literal"]).toContain(out.mode);
    expect(typeof out.truncated).toBe("boolean");
    expect(out.warnings).toBeArray();
  });

  test("fallback uses literal mode with warning", async () => {
    const out = grepOutput(await tool.execute({ pattern: "export const" }));
    // In this env rg is missing, so mode should be "literal"
    if (out.mode === "literal") {
      expect(out.warnings.some((w) => w.includes("literal"))).toBe(true);
    }
  });

  test("multiline literal match across lines in fallback", async () => {
    const result = grepText(
      await tool.execute({
        pattern: "b = 2;\nexport",
        output_mode: "files_with_matches",
        multiline: true,
      }),
    );
    expect(result).toContain("beta.ts");
  });

  test("fallback reports skipped files in warnings", async () => {
    const out = grepOutput(await tool.execute({ pattern: "x", output_mode: "files_with_matches" }));
    if (out.mode === "literal") {
      expect(out.warnings.some((w) => w.includes("skipped"))).toBe(true);
    }
  });

  test("returns error for nonexistent in-workspace path", async () => {
    const result = (await tool.execute({
      pattern: "export",
      path: join(TMP, "does-not-exist"),
    })) as { readonly error: string };
    expect(result.error).toBeString();
  });

  test("fails closed for regex patterns when rg unavailable", async () => {
    // "(" contains regex metacharacters — should error, not silently degrade
    const result = (await tool.execute({ pattern: "(" })) as { readonly error: string };
    expect(result.error).toContain("regex");
  });

  test("fails closed for complex regex patterns when rg unavailable", async () => {
    const result = (await tool.execute({
      pattern: "(a+)+$",
      output_mode: "files_with_matches",
      glob: "*.ts",
    })) as { readonly error: string };
    expect(result.error).toContain("regex");
  });

  test("fallback supports context lines", async () => {
    const result = grepText(
      await tool.execute({
        pattern: "const b =",
        output_mode: "content",
        "-A": 1,
        glob: "*.ts",
      }),
    );
    expect(result).toContain("const b = 2");
    expect(result).toContain("const bb = 22");
  });

  test("fallback type filter searches recursively", async () => {
    // sub/gamma.ts should be found when using type: "ts"
    const result = grepText(
      await tool.execute({
        pattern: "const g",
        output_mode: "files_with_matches",
        type: "ts",
      }),
    );
    expect(result).toContain("gamma.ts");
  });
});

// ---------------------------------------------------------------------------
// ToolSearch tool
// ---------------------------------------------------------------------------

const MOCK_TOOLS: readonly ToolSummary[] = [
  { name: "Read", description: "Read a file from the filesystem" },
  { name: "Edit", description: "Edit a file with search-replace" },
  { name: "Write", description: "Write a new file to the filesystem" },
  { name: "Glob", description: "Fast file pattern matching" },
  { name: "Grep", description: "Content search with ripgrep" },
];

describe("createToolSearchTool", () => {
  const tool = createToolSearchTool({ getTools: () => MOCK_TOOLS });

  test("descriptor has correct shape", () => {
    expect(tool.descriptor.name).toBe("ToolSearch");
    expect(tool.descriptor.description).toBeString();
    expect(tool.origin).toBe("primordial");
  });

  test("select: returns exact tools by name", async () => {
    const result = (await tool.execute({ query: "select:Read,Edit" })) as readonly ToolSummary[];
    expect(result.length).toBe(2);
    expect(result[0]?.name).toBe("Read");
    expect(result[1]?.name).toBe("Edit");
  });

  test("keyword search matches tool names", async () => {
    const result = (await tool.execute({ query: "Glob" })) as readonly ToolSummary[];
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.name).toBe("Glob");
  });

  test("keyword search matches tool descriptions", async () => {
    const result = (await tool.execute({ query: "filesystem" })) as readonly ToolSummary[];
    expect(result.length).toBeGreaterThan(0);
    const names = result.map((t) => t.name);
    expect(names).toContain("Read");
  });

  test("respects max_results", async () => {
    const result = (await tool.execute({
      query: "file",
      max_results: 2,
    })) as readonly ToolSummary[];
    expect(result.length).toBeLessThanOrEqual(2);
  });

  test("returns empty array for no matches", async () => {
    const result = (await tool.execute({ query: "nonexistent-xyz" })) as readonly ToolSummary[];
    expect(result).toEqual([]);
  });

  test("rejects empty query", async () => {
    const result = (await tool.execute({ query: "" })) as { readonly error: string };
    expect(result.error).toBeString();
  });
});

// ---------------------------------------------------------------------------
// ComponentProvider
// ---------------------------------------------------------------------------

describe("createBuiltinSearchProvider", () => {
  test("attaches all 3 tools", async () => {
    const provider = createBuiltinSearchProvider({
      cwd: TMP,
      getTools: () => MOCK_TOOLS,
    });
    expect(provider.name).toBe("builtin-search");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only: Agent stub
    const result = await provider.attach({} as never);
    const components = isAttachResult(result) ? result.components : result;
    expect(components.has("tool:Glob")).toBe(true);
    expect(components.has("tool:Grep")).toBe(true);
    expect(components.has("tool:ToolSearch")).toBe(true);
  });

  test("respects operations filter", async () => {
    const provider = createBuiltinSearchProvider({
      cwd: TMP,
      getTools: () => MOCK_TOOLS,
      operations: ["Glob", "ToolSearch"],
    });

    const result = await provider.attach({} as never);
    const components = isAttachResult(result) ? result.components : result;
    expect(components.has("tool:Glob")).toBe(true);
    expect(components.has("tool:Grep")).toBe(false);
    expect(components.has("tool:ToolSearch")).toBe(true);
  });
});
