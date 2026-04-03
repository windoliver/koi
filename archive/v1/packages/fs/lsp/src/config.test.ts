import { describe, expect, test } from "bun:test";
import type { LspProviderConfig, LspServerConfig } from "./config.js";
import { resolveProviderConfig, resolveServerConfig, validateLspConfig } from "./config.js";

// ---------------------------------------------------------------------------
// validateLspConfig
// ---------------------------------------------------------------------------

describe("validateLspConfig", () => {
  test("validates a minimal valid config", () => {
    const result = validateLspConfig({
      servers: [{ name: "ts", command: "typescript-language-server", rootUri: "file:///project" }],
    });
    expect(result.ok).toBe(true);
  });

  test("validates config with all optional fields", () => {
    const result = validateLspConfig({
      servers: [
        {
          name: "pyright",
          command: "pyright-langserver",
          args: ["--stdio"],
          env: { PYTHONPATH: "/usr/lib" },
          rootUri: "file:///workspace",
          languageId: "python",
          initializationOptions: { python: { analysis: { typeCheckingMode: "strict" } } },
          timeoutMs: 60_000,
        },
      ],
      connectTimeoutMs: 15_000,
      maxReconnectAttempts: 5,
      maxReferences: 200,
      maxSymbols: 100,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects empty servers array", () => {
    const result = validateLspConfig({ servers: [] });
    expect(result.ok).toBe(false);
  });

  test("rejects missing name", () => {
    const result = validateLspConfig({
      servers: [{ command: "lsp", rootUri: "file:///x" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects missing command", () => {
    const result = validateLspConfig({
      servers: [{ name: "x", rootUri: "file:///x" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects missing rootUri", () => {
    const result = validateLspConfig({
      servers: [{ name: "x", command: "lsp" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects negative timeoutMs", () => {
    const result = validateLspConfig({
      servers: [{ name: "x", command: "lsp", rootUri: "file:///x", timeoutMs: -1 }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects non-object input", () => {
    const result = validateLspConfig("not an object");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveServerConfig
// ---------------------------------------------------------------------------

describe("resolveServerConfig", () => {
  test("applies defaults for minimal config", () => {
    const server: LspServerConfig = {
      name: "ts",
      command: "typescript-language-server",
      rootUri: "file:///project",
    };
    const resolved = resolveServerConfig(server);
    expect(resolved.name).toBe("ts");
    expect(resolved.command).toBe("typescript-language-server");
    expect(resolved.args).toEqual([]);
    expect(resolved.env).toEqual({});
    expect(resolved.rootUri).toBe("file:///project");
    expect(resolved.languageId).toBeUndefined();
    expect(resolved.timeoutMs).toBe(30_000);
  });

  test("preserves explicit values", () => {
    const server: LspServerConfig = {
      name: "pyright",
      command: "pyright-langserver",
      args: ["--stdio"],
      env: { PYTHONPATH: "/usr/lib" },
      rootUri: "file:///workspace",
      languageId: "python",
      timeoutMs: 60_000,
    };
    const resolved = resolveServerConfig(server);
    expect(resolved.args).toEqual(["--stdio"]);
    expect(resolved.env).toEqual({ PYTHONPATH: "/usr/lib" });
    expect(resolved.languageId).toBe("python");
    expect(resolved.timeoutMs).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// resolveProviderConfig
// ---------------------------------------------------------------------------

describe("resolveProviderConfig", () => {
  test("applies provider-level defaults", () => {
    const config: LspProviderConfig = {
      servers: [{ name: "ts", command: "tls", rootUri: "file:///project" }],
    };
    const resolved = resolveProviderConfig(config);
    expect(resolved.connectTimeoutMs).toBe(30_000);
    expect(resolved.maxReconnectAttempts).toBe(3);
    expect(resolved.maxReferences).toBe(100);
    expect(resolved.maxSymbols).toBe(50);
    expect(resolved.servers).toHaveLength(1);
  });

  test("preserves explicit provider-level values", () => {
    const config: LspProviderConfig = {
      servers: [{ name: "ts", command: "tls", rootUri: "file:///project" }],
      connectTimeoutMs: 15_000,
      maxReconnectAttempts: 5,
      maxReferences: 200,
      maxSymbols: 100,
    };
    const resolved = resolveProviderConfig(config);
    expect(resolved.connectTimeoutMs).toBe(15_000);
    expect(resolved.maxReconnectAttempts).toBe(5);
    expect(resolved.maxReferences).toBe(200);
    expect(resolved.maxSymbols).toBe(100);
  });
});
