import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Tool } from "@koi/core";
import { toolToken } from "@koi/core";
import type { LspClient } from "./client.js";
import type { CreateClientFn } from "./component-provider.js";
import { createLspComponentProvider } from "./component-provider.js";
import type { LspProviderConfig } from "./config.js";
import type { Diagnostic, ServerCapabilities } from "./types.js";

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

interface MockClientConfig {
  readonly name: string;
  readonly capabilities?: ServerCapabilities;
  readonly shouldFailConnect?: boolean;
}

function createMockClientFactory(configs: readonly MockClientConfig[]): CreateClientFn {
  // let is justified: index counter for sequential mock creation
  let index = 0;

  return (): LspClient => {
    const cfg = configs[index++];
    if (cfg === undefined) {
      throw new Error("More clients created than expected");
    }

    const caps = cfg.capabilities ?? {
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
    };

    const client: LspClient = {
      connect: async () => {
        if (cfg.shouldFailConnect === true) {
          return {
            ok: false,
            error: {
              code: "EXTERNAL",
              message: `Mock connection failed for "${cfg.name}"`,
              retryable: false,
            },
          };
        }
        return { ok: true, value: undefined };
      },
      hover: async () => ({ ok: true, value: null }),
      gotoDefinition: async () => ({ ok: true, value: [] }),
      findReferences: async () => ({ ok: true, value: [] }),
      documentSymbols: async () => ({ ok: true, value: [] }),
      workspaceSymbols: async () => ({ ok: true, value: [] }),
      openDocument: async () => ({ ok: true, value: undefined }),
      closeDocument: async () => ({ ok: true, value: undefined }),
      getDiagnostics: () => new Map<string, readonly Diagnostic[]>(),
      capabilities: () => caps,
      close: async () => {},
      isConnected: () => !cfg.shouldFailConnect,
      serverName: () => cfg.name,
    };

    return client;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLspComponentProvider", () => {
  test("creates provider with tools from a single server", async () => {
    const config: LspProviderConfig = {
      servers: [{ name: "ts", command: "tls", rootUri: "file:///project" }],
    };

    const factory = createMockClientFactory([{ name: "ts" }]);
    const result = await createLspComponentProvider(config, factory);

    expect(result.failures).toHaveLength(0);
    expect(result.clients).toHaveLength(1);

    // Attach should return tools
    const tools = await result.provider.attach({} as never);
    expect(tools.size).toBe(8); // 3 always + 5 capability tools
  });

  test("handles partial failures across servers", async () => {
    const config: LspProviderConfig = {
      servers: [
        { name: "good", command: "tls", rootUri: "file:///project" },
        { name: "bad", command: "broken", rootUri: "file:///project" },
      ],
    };

    const factory = createMockClientFactory([
      { name: "good" },
      { name: "bad", shouldFailConnect: true },
    ]);
    const result = await createLspComponentProvider(config, factory);

    expect(result.clients).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.serverName).toBe("bad");

    // Still have tools from the good server
    const tools = await result.provider.attach({} as never);
    expect(tools.size).toBe(8);
  });

  test("creates only document tools when capabilities empty", async () => {
    const config: LspProviderConfig = {
      servers: [{ name: "minimal", command: "lsp", rootUri: "file:///project" }],
    };

    const factory = createMockClientFactory([{ name: "minimal", capabilities: {} }]);
    const result = await createLspComponentProvider(config, factory);

    const tools = await result.provider.attach({} as never);
    expect(tools.size).toBe(3); // open + close + get_diagnostics
  });

  test("tools from multiple servers are namespaced correctly", async () => {
    const config: LspProviderConfig = {
      servers: [
        { name: "ts", command: "tls", rootUri: "file:///project" },
        { name: "py", command: "pyright", rootUri: "file:///project" },
      ],
    };

    const factory = createMockClientFactory([{ name: "ts" }, { name: "py" }]);
    const result = await createLspComponentProvider(config, factory);

    expect(result.clients).toHaveLength(2);

    const tools = await result.provider.attach({} as never);
    expect(tools.size).toBe(16); // 8 per server

    // Verify namespacing
    const tsHover = tools.get(toolToken("lsp/ts/hover") as string) as Tool | undefined;
    const pyHover = tools.get(toolToken("lsp/py/hover") as string) as Tool | undefined;
    expect(tsHover).toBeDefined();
    expect(pyHover).toBeDefined();
  });

  test("all servers failing returns empty provider", async () => {
    const config: LspProviderConfig = {
      servers: [
        { name: "bad1", command: "x", rootUri: "file:///project" },
        { name: "bad2", command: "y", rootUri: "file:///project" },
      ],
    };

    const factory = createMockClientFactory([
      { name: "bad1", shouldFailConnect: true },
      { name: "bad2", shouldFailConnect: true },
    ]);
    const result = await createLspComponentProvider(config, factory);

    expect(result.clients).toHaveLength(0);
    expect(result.failures).toHaveLength(2);

    const tools = await result.provider.attach({} as never);
    expect(tools.size).toBe(0);
  });

  test("detach closes all clients", async () => {
    const config: LspProviderConfig = {
      servers: [{ name: "ts", command: "tls", rootUri: "file:///project" }],
    };

    // let is justified: tracking close call
    let closed = false;
    const factory: CreateClientFn = () => ({
      connect: async () => ({ ok: true, value: undefined }),
      hover: async () => ({ ok: true, value: null }),
      gotoDefinition: async () => ({ ok: true, value: [] }),
      findReferences: async () => ({ ok: true, value: [] }),
      documentSymbols: async () => ({ ok: true, value: [] }),
      workspaceSymbols: async () => ({ ok: true, value: [] }),
      openDocument: async () => ({ ok: true, value: undefined }),
      closeDocument: async () => ({ ok: true, value: undefined }),
      getDiagnostics: () => new Map<string, readonly Diagnostic[]>(),
      capabilities: () => ({
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
      }),
      close: async () => {
        closed = true;
      },
      isConnected: () => true,
      serverName: () => "ts",
    });

    const result = await createLspComponentProvider(config, factory);
    expect(closed).toBe(false);

    await result.provider.detach?.({} as never);
    expect(closed).toBe(true);
  });

  test("provider name is 'lsp'", async () => {
    const config: LspProviderConfig = {
      servers: [{ name: "ts", command: "tls", rootUri: "file:///project" }],
    };

    const factory = createMockClientFactory([{ name: "ts" }]);
    const result = await createLspComponentProvider(config, factory);

    expect(result.provider.name).toBe("lsp");
  });

  // -----------------------------------------------------------------------
  // Auto-detection
  // -----------------------------------------------------------------------

  const originalWhich = Bun.which;

  afterEach(() => {
    Bun.which = originalWhich;
  });

  test("auto-detected servers are used when autoDetect is true", async () => {
    Bun.which = mock((binary: string) => {
      if (binary === "gopls") return "/usr/local/bin/gopls";
      return null;
    }) as typeof Bun.which;

    const config: LspProviderConfig = {
      servers: [{ name: "ts", command: "tls", rootUri: "file:///project" }],
      autoDetect: true,
    };

    // Factory expects 2 clients: ts (user) + gopls (auto-detected)
    const factory = createMockClientFactory([{ name: "ts" }, { name: "gopls" }]);
    const result = await createLspComponentProvider(config, factory);

    expect(result.clients).toHaveLength(2);
    expect(result.failures).toHaveLength(0);

    const tools = await result.provider.attach({} as never);
    expect(tools.size).toBe(16); // 8 per server
  });

  test("user-configured servers override auto-detected ones by name", async () => {
    Bun.which = mock((binary: string) => {
      if (binary === "typescript-language-server") return "/usr/bin/typescript-language-server";
      return null;
    }) as typeof Bun.which;

    const config: LspProviderConfig = {
      servers: [{ name: "typescript", command: "my-custom-ts-lsp", rootUri: "file:///project" }],
      autoDetect: true,
    };

    // Only 1 client — user's "typescript" takes priority, auto-detected skipped
    const factory = createMockClientFactory([{ name: "typescript" }]);
    const result = await createLspComponentProvider(config, factory);

    expect(result.clients).toHaveLength(1);
    expect(result.failures).toHaveLength(0);
  });
});
