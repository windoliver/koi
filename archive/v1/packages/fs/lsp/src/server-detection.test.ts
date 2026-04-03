import { afterEach, describe, expect, mock, test } from "bun:test";
import { detectLspServers } from "./server-detection.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalWhich = Bun.which;

afterEach(() => {
  Bun.which = originalWhich;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectLspServers", () => {
  test("returns empty array when no binaries found", () => {
    Bun.which = mock(() => null) as typeof Bun.which;
    const result = detectLspServers();
    expect(result).toEqual([]);
  });

  test("detects server when binary exists in PATH", () => {
    Bun.which = mock((binary: string) => {
      if (binary === "gopls") return "/usr/local/bin/gopls";
      return null;
    }) as typeof Bun.which;

    const result = detectLspServers();
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("gopls");
    expect(result[0]?.command).toBe("/usr/local/bin/gopls");
    expect(result[0]?.args).toEqual(["serve"]);
    expect(result[0]?.languageIds).toContain("go");
  });

  test("finds first matching binary from candidates", () => {
    Bun.which = mock((binary: string) => {
      // pyright-langserver not found, but pyright is
      if (binary === "pyright") return "/usr/bin/pyright";
      return null;
    }) as typeof Bun.which;

    const result = detectLspServers();
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("pyright");
    expect(result[0]?.command).toBe("/usr/bin/pyright");
    expect(result[0]?.args).toEqual(["--stdio"]);
    expect(result[0]?.languageIds).toContain("python");
  });

  test("detects multiple servers", () => {
    Bun.which = mock((binary: string) => {
      if (binary === "typescript-language-server")
        return "/usr/local/bin/typescript-language-server";
      if (binary === "rust-analyzer") return "/usr/local/bin/rust-analyzer";
      return null;
    }) as typeof Bun.which;

    const result = detectLspServers();
    expect(result).toHaveLength(2);

    const names = result.map((s) => s.name);
    expect(names).toContain("typescript");
    expect(names).toContain("rust-analyzer");
  });

  test("returns correct args and languageIds per server", () => {
    Bun.which = mock((binary: string) => {
      if (binary === "typescript-language-server") return "/usr/bin/typescript-language-server";
      return null;
    }) as typeof Bun.which;

    const result = detectLspServers();
    expect(result).toHaveLength(1);
    expect(result[0]?.args).toEqual(["--stdio"]);
    expect(result[0]?.languageIds).toEqual([
      "typescript",
      "javascript",
      "typescriptreact",
      "javascriptreact",
    ]);
  });
});
