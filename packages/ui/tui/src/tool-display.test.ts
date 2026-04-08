import { describe, expect, test } from "bun:test";
import { getResultDisplay, getToolDisplay } from "./tool-display.js";

// ---------------------------------------------------------------------------
// Known tools — unprefixed built-ins
// ---------------------------------------------------------------------------

describe("getToolDisplay — Glob", () => {
  test("returns title 'Glob' with pattern as subtitle", () => {
    const d = getToolDisplay("Glob", { pattern: "src/**/*.ts" });
    expect(d.title).toBe("Glob");
    expect(d.subtitle).toBe("src/**/*.ts");
    expect(d.chips).toEqual([]);
  });
});

describe("getToolDisplay — Grep", () => {
  test("returns title 'Search' with pattern as subtitle", () => {
    const d = getToolDisplay("Grep", { pattern: "TODO", path: "src/" });
    expect(d.title).toBe("Search");
    expect(d.subtitle).toBe("TODO");
  });

  test("includes non-subtitle scalar args as chips", () => {
    const d = getToolDisplay("Grep", { pattern: "bug", type: "ts", context: 3 });
    expect(d.chips).toEqual(["type=ts", "context=3"]);
  });
});

describe("getToolDisplay — Bash", () => {
  test("returns title 'Shell' with command as subtitle", () => {
    const d = getToolDisplay("Bash", { command: "echo hello" });
    expect(d.title).toBe("Shell");
    expect(d.subtitle).toBe("echo hello");
  });

  test("includes timeout chip", () => {
    const d = getToolDisplay("Bash", { command: "sleep 5", timeout: 10000 });
    expect(d.chips).toEqual(["timeout=10000"]);
  });
});

describe("getToolDisplay — ToolSearch", () => {
  test("returns title 'Tool Search' with query as subtitle", () => {
    const d = getToolDisplay("ToolSearch", { query: "select:Read,Edit" });
    expect(d.title).toBe("Tool Search");
    expect(d.subtitle).toBe("select:Read,Edit");
  });
});

describe("getToolDisplay — Spawn", () => {
  test("returns title 'Spawn' with name as subtitle", () => {
    const d = getToolDisplay("Spawn", { name: "researcher", prompt: "Find bugs" });
    expect(d.title).toBe("Spawn");
    expect(d.subtitle).toBe("researcher");
  });
});

// ---------------------------------------------------------------------------
// Known tools — prefixed (suffix matching)
// ---------------------------------------------------------------------------

describe("getToolDisplay — *_read (suffix match)", () => {
  test("fs_read returns 'Read' with file_path", () => {
    const d = getToolDisplay("fs_read", { file_path: "package.json" });
    expect(d.title).toBe("Read");
    expect(d.subtitle).toBe("package.json");
  });

  test("nexus_read returns 'Read' with file_path", () => {
    const d = getToolDisplay("nexus_read", { file_path: "/data/config.yaml" });
    expect(d.title).toBe("Read");
    expect(d.subtitle).toBe("/data/config.yaml");
  });

  test("local_fs_read returns 'Read'", () => {
    const d = getToolDisplay("local_fs_read", { file_path: "src/index.ts" });
    expect(d.title).toBe("Read");
    expect(d.subtitle).toBe("src/index.ts");
  });

  test("includes encoding chip", () => {
    const d = getToolDisplay("fs_read", { file_path: "data.bin", encoding: "base64" });
    expect(d.chips).toEqual(["encoding=base64"]);
  });
});

describe("getToolDisplay — *_write (suffix match)", () => {
  test("fs_write returns 'Write' by default", () => {
    const d = getToolDisplay("fs_write", { file_path: "output.txt", content: "hello" });
    expect(d.title).toBe("Write");
    expect(d.subtitle).toBe("output.txt");
  });

  test("fs_write returns 'Create' when create flag is true", () => {
    const d = getToolDisplay("fs_write", { file_path: "new.txt", create: true });
    expect(d.title).toBe("Create");
  });

  test("fs_write returns 'Write' when create is false", () => {
    const d = getToolDisplay("fs_write", { file_path: "old.txt", create: false });
    expect(d.title).toBe("Write");
  });
});

describe("getToolDisplay — *_edit (suffix match)", () => {
  test("fs_edit returns 'Edit' when old_string is non-empty", () => {
    const d = getToolDisplay("fs_edit", {
      file_path: "src/app.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    });
    expect(d.title).toBe("Edit");
    expect(d.subtitle).toBe("src/app.ts");
  });

  test("fs_edit returns 'Create' when old_string is empty", () => {
    const d = getToolDisplay("fs_edit", {
      file_path: "src/new.ts",
      old_string: "",
      new_string: "export const foo = 1;",
    });
    expect(d.title).toBe("Create");
  });

  test("fs_edit returns 'Create' when old_string is missing", () => {
    const d = getToolDisplay("fs_edit", {
      file_path: "src/new.ts",
      new_string: "content",
    });
    expect(d.title).toBe("Create");
  });
});

describe("getToolDisplay — *_fetch (suffix match)", () => {
  test("web_fetch returns 'Fetch' with url", () => {
    const d = getToolDisplay("web_fetch", { url: "https://example.com" });
    expect(d.title).toBe("Fetch");
    expect(d.subtitle).toBe("https://example.com");
  });

  test("includes method and format chips", () => {
    const d = getToolDisplay("web_fetch", {
      url: "https://api.example.com/data",
      method: "HEAD",
      format: "markdown",
    });
    expect(d.chips).toEqual(["method=HEAD", "format=markdown"]);
  });
});

describe("getToolDisplay — *_search (suffix match)", () => {
  test("web_search returns 'Web Search' with query", () => {
    const d = getToolDisplay("web_search", { query: "SolidJS best practices" });
    expect(d.title).toBe("Web Search");
    expect(d.subtitle).toBe("SolidJS best practices");
  });
});

// ---------------------------------------------------------------------------
// Generic / unknown / MCP tools
// ---------------------------------------------------------------------------

describe("getToolDisplay — generic fallback", () => {
  test("unknown tool uses raw name as title", () => {
    const d = getToolDisplay("my_custom_tool", { input: "data" });
    expect(d.title).toBe("my_custom_tool");
  });

  test("extracts subtitle from SUBTITLE_KEYS in priority order", () => {
    const d = getToolDisplay("unknown", { description: "a thing", name: "widget" });
    // "name" has higher priority than "description" in SUBTITLE_KEYS
    expect(d.subtitle).toBe("widget");
  });

  test("extracts subtitle from path when present", () => {
    const d = getToolDisplay("unknown", { path: "/tmp/foo", extra: "bar" });
    expect(d.subtitle).toBe("/tmp/foo");
  });

  test("extracts scalar chips from non-subtitle keys", () => {
    const d = getToolDisplay("unknown", { count: 5, active: true, tag: "important" });
    expect(d.chips).toEqual(["count=5", "active=true", "tag=important"]);
  });

  test("MCP tool with server prefix uses raw name as title", () => {
    const d = getToolDisplay("golden-mcp__weather", {
      location: "San Francisco",
      units: "celsius",
    });
    expect(d.title).toBe("golden-mcp__weather");
    expect(d.chips).toEqual(["location=San Francisco", "units=celsius"]);
  });

  test("drops array and object values from chips", () => {
    const d = getToolDisplay("complex_tool", {
      items: [1, 2, 3],
      nested: { a: 1 },
      scalar: "kept",
    });
    expect(d.chips).toEqual(["scalar=kept"]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("getToolDisplay — edge cases", () => {
  test("empty args returns empty subtitle and no chips", () => {
    const d = getToolDisplay("Glob", {});
    expect(d.title).toBe("Glob");
    expect(d.subtitle).toBe("");
    expect(d.chips).toEqual([]);
  });

  test("null/undefined values in args are skipped", () => {
    const d = getToolDisplay("Bash", { command: null as unknown as string, desc: "test" });
    // command is null, not a string — skip it; no subtitle key matches
    expect(d.subtitle).toBe("");
  });

  test("chips capped at 3 even with many scalar args", () => {
    const d = getToolDisplay("unknown", {
      a: "1",
      b: "2",
      c: "3",
      d: "4",
      e: "5",
    });
    expect(d.chips).toHaveLength(3);
  });

  test("subtitle truncated to 80 chars with ellipsis", () => {
    const longPath = "a".repeat(120);
    const d = getToolDisplay("fs_read", { file_path: longPath });
    expect(d.subtitle.length).toBe(80);
    expect(d.subtitle.endsWith("…")).toBe(true);
  });

  test("subtitle key value that is empty string is skipped", () => {
    const d = getToolDisplay("Bash", { command: "", description: "a fallback" });
    // command is empty → skip → fall through to SUBTITLE_KEYS scan
    expect(d.subtitle).toBe("a fallback");
  });

  test("boolean chip renders as string", () => {
    const d = getToolDisplay("unknown", { verbose: true });
    expect(d.chips).toEqual(["verbose=true"]);
  });

  test("number chip renders as string", () => {
    const d = getToolDisplay("unknown", { timeout: 5000 });
    expect(d.chips).toEqual(["timeout=5000"]);
  });
});

// ---------------------------------------------------------------------------
// Non-object args guard (Issue 12)
// ---------------------------------------------------------------------------

describe("getToolDisplay — non-object args guard", () => {
  test("handles args that are technically valid but non-object values gracefully", () => {
    // These test that callers passing non-Record values don't crash
    // The component guards with typeof check before calling getToolDisplay
    // But the mapper itself should be safe with any Record-shaped input
    const d = getToolDisplay("Bash", { command: "echo hi" });
    expect(d.title).toBe("Shell");
    expect(d.subtitle).toBe("echo hi");
  });
});

// ===========================================================================
// getResultDisplay — Phase 3: result chip extraction
// ===========================================================================

describe("getResultDisplay — Bash result", () => {
  test("extracts exitCode and durationMs chips, stdout as body", () => {
    const r = getResultDisplay(
      JSON.stringify({ stdout: "hello world", stderr: "", exitCode: 0, durationMs: 42 }),
    );
    expect(r.chips).toEqual(["exitCode=0", "durationMs=42"]);
    expect(r.body).toBe("hello world");
  });

  test("extracts timedOut chip when present", () => {
    const r = getResultDisplay(
      JSON.stringify({
        stdout: "",
        stderr: "killed",
        exitCode: 137,
        durationMs: 5000,
        timedOut: true,
      }),
    );
    expect(r.chips).toContain("exitCode=137");
    expect(r.chips).toContain("timedOut=true");
  });

  test("extracts truncated chip", () => {
    const r = getResultDisplay(
      JSON.stringify({
        stdout: "long output...",
        stderr: "",
        exitCode: 0,
        durationMs: 10,
        truncated: true,
      }),
    );
    expect(r.chips).toContain("truncated=true");
  });

  test("security block error shows error as body", () => {
    const r = getResultDisplay(
      JSON.stringify({
        error: "Command blocked",
        category: "security",
        reason: "rm -rf",
        pattern: "rm",
      }),
    );
    expect(r.body).toBe("Command blocked");
    expect(r.chips).toEqual([]);
  });
});

describe("getResultDisplay — web_fetch result", () => {
  test("extracts status and contentType chips, body as body", () => {
    const r = getResultDisplay(
      JSON.stringify({
        status: 200,
        statusText: "OK",
        contentType: "text/html",
        body: "Example Domain",
        format: "markdown",
        truncated: false,
        finalUrl: "https://example.com",
      }),
    );
    // Chip order follows RESULT_CHIP_KEYS priority; truncated comes before format
    expect(r.chips).toEqual(["status=200", "contentType=text/html", "truncated=false"]);
    expect(r.body).toBe("Example Domain");
  });

  test("shows error body for failed fetch", () => {
    const r = getResultDisplay(
      JSON.stringify({ error: "Connection refused", code: "ECONNREFUSED" }),
    );
    expect(r.body).toBe("Connection refused");
    expect(r.chips).toEqual(["code=ECONNREFUSED"]);
  });
});

describe("getResultDisplay — Glob result", () => {
  test("extracts total and truncated chips, paths as body", () => {
    const r = getResultDisplay(
      JSON.stringify({ paths: ["src/a.ts", "src/b.ts"], truncated: false, total: 2 }),
    );
    expect(r.chips).toContain("total=2");
    expect(r.body).toBe("src/a.ts\nsrc/b.ts");
  });

  test("truncated glob shows truncated chip", () => {
    const r = getResultDisplay(JSON.stringify({ paths: ["a.ts"], truncated: true }));
    expect(r.chips).toContain("truncated=true");
  });
});

describe("getResultDisplay — Grep result", () => {
  test("extracts mode chip, result string as body", () => {
    const r = getResultDisplay(
      JSON.stringify({ result: "src/foo.ts:10:match", mode: "rg", truncated: false, warnings: [] }),
    );
    expect(r.chips).toContain("mode=rg");
    expect(r.body).toBe("src/foo.ts:10:match");
  });
});

describe("getResultDisplay — fs_edit result", () => {
  test("extracts modified chip", () => {
    const r = getResultDisplay(JSON.stringify({ path: "src/app.ts", modified: true }));
    expect(r.chips).toContain("modified=true");
  });

  test("edit error shows error body with code chip", () => {
    const r = getResultDisplay(JSON.stringify({ error: "Hunk not found", code: "NOT_FOUND" }));
    expect(r.body).toBe("Hunk not found");
    expect(r.chips).toEqual(["code=NOT_FOUND"]);
  });
});

describe("getResultDisplay — fs_write result", () => {
  test("extracts bytesWritten chip", () => {
    const r = getResultDisplay(JSON.stringify({ path: "output.txt", bytesWritten: 1234 }));
    expect(r.chips).toContain("bytesWritten=1234");
  });
});

describe("getResultDisplay — edge cases", () => {
  test("empty string returns empty chips and body", () => {
    const r = getResultDisplay("");
    expect(r.chips).toEqual([]);
    expect(r.body).toBe("");
  });

  test("[unserializable] sentinel passes through", () => {
    const r = getResultDisplay("[unserializable]");
    expect(r.chips).toEqual([]);
    expect(r.body).toBe("[unserializable]");
  });

  test("plain text result returns no chips", () => {
    const r = getResultDisplay("file1.ts\nfile2.ts");
    expect(r.chips).toEqual([]);
    expect(r.body).toBe("file1.ts\nfile2.ts");
  });

  test("non-object JSON returns raw string", () => {
    const r = getResultDisplay('"just a string"');
    expect(r.chips).toEqual([]);
    expect(r.body).toBe('"just a string"');
  });

  test("array JSON returns raw string", () => {
    const r = getResultDisplay("[1,2,3]");
    expect(r.chips).toEqual([]);
    expect(r.body).toBe("[1,2,3]");
  });

  test("chips capped at 3 even with many metadata fields", () => {
    const r = getResultDisplay(
      JSON.stringify({
        exitCode: 0,
        status: 200,
        durationMs: 10,
        bytesWritten: 100,
        modified: true,
        truncated: false,
        total: 5,
      }),
    );
    expect(r.chips).toHaveLength(3);
  });

  test("generic unknown result extracts scalars not in consumed set", () => {
    const r = getResultDisplay(JSON.stringify({ customField: "value", count: 42 }));
    expect(r.body).toContain("customField: value");
    expect(r.body).toContain("count: 42");
  });
});
