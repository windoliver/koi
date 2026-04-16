import { describe, expect, mock, test } from "bun:test";
import type { McpConnection, McpServerFailure, OAuthAuthProvider } from "@koi/mcp";
import type { AuthServerEntry } from "./mcp-auth-tools.js";
import { createCliAuthToolFactory } from "./mcp-auth-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAuthProvider(opts?: {
  readonly startAuthFlowResult?: boolean;
}): OAuthAuthProvider {
  return {
    token: () => undefined,
    startAuthFlow: mock(async () => opts?.startAuthFlowResult ?? true),
    handleUnauthorized: mock(async () => {}),
  };
}

function createMockConnection(
  name: string,
  opts?: {
    readonly shouldFailConnect?: boolean;
    readonly connectErrorMessage?: string;
  },
): McpConnection {
  return {
    serverName: name,
    state: { kind: "idle" as const },
    connect: mock(
      async (): Promise<import("@koi/core").Result<void, import("@koi/core").KoiError>> => {
        if (opts?.shouldFailConnect === true) {
          return {
            ok: false as const,
            error: {
              code: "EXTERNAL",
              message: opts.connectErrorMessage ?? "Connection refused",
              retryable: false,
            },
          };
        }
        return { ok: true as const, value: undefined };
      },
    ),
    listTools: mock(async () => ({ ok: true as const, value: [] as const })),
    callTool: mock(async () => ({ ok: true as const, value: undefined })),
    close: mock(async () => {}),
    onStateChange: () => () => {},
    onToolsChanged: () => () => {},
  };
}

function makeFailure(serverName: string): McpServerFailure {
  return {
    serverName,
    error: { code: "AUTH_REQUIRED", message: "Authentication required", retryable: false },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCliAuthToolFactory", () => {
  test("creates authenticate tool for auth-needed server", () => {
    const provider = createMockAuthProvider();
    const connection = createMockConnection("jira");
    const servers = new Map<string, AuthServerEntry>([
      ["jira", { provider, connection, url: "https://example.com/jira/mcp" }],
    ]);
    const rediscover = mock(async () => []);

    const factory = createCliAuthToolFactory({ servers, rediscover });
    const tools = factory(makeFailure("jira"));

    expect(tools).toHaveLength(1);
    expect(tools[0]?.descriptor.name).toBe("jira__authenticate");
  });

  test("authenticate tool description includes server name and URL", () => {
    const provider = createMockAuthProvider();
    const connection = createMockConnection("jira");
    const servers = new Map<string, AuthServerEntry>([
      ["jira", { provider, connection, url: "https://maas.example.com/jira/mcp" }],
    ]);

    const factory = createCliAuthToolFactory({ servers, rediscover: async () => [] });
    const tools = factory(makeFailure("jira"));

    const desc = tools[0]?.descriptor.description ?? "";
    expect(desc).toContain('"jira"');
    // URL is redacted to origin-only (no path/query)
    expect(desc).toContain("https://maas.example.com");
    expect(desc).not.toContain("/jira/mcp");
    expect(desc).toContain("authentication");
  });

  test("returns empty array for unknown server", () => {
    const servers = new Map<string, AuthServerEntry>();
    const factory = createCliAuthToolFactory({ servers, rediscover: async () => [] });
    const tools = factory(makeFailure("unknown"));

    expect(tools).toHaveLength(0);
  });

  test("authenticate execute calls startAuthFlow and reconnects on success", async () => {
    const provider = createMockAuthProvider({ startAuthFlowResult: true });
    const connection = createMockConnection("jira");
    const rediscover = mock(async () => []);
    const servers = new Map<string, AuthServerEntry>([
      ["jira", { provider, connection, url: "https://example.com/mcp" }],
    ]);

    const factory = createCliAuthToolFactory({ servers, rediscover });
    const tools = factory(makeFailure("jira"));
    expect(tools[0]).toBeDefined();
    const authTool = tools[0] as (typeof tools)[number];

    const result = await authTool.execute({});
    const content = result as {
      readonly content: readonly { readonly type: string; readonly text: string }[];
    };

    expect(provider.startAuthFlow).toHaveBeenCalledTimes(1);
    expect(connection.connect).toHaveBeenCalledTimes(1);
    expect(rediscover).toHaveBeenCalledTimes(1);
    expect(content.content[0]?.text).toContain("successful");
  });

  test("authenticate execute returns error when auth flow fails", async () => {
    const provider = createMockAuthProvider({ startAuthFlowResult: false });
    const connection = createMockConnection("jira");
    const servers = new Map<string, AuthServerEntry>([
      ["jira", { provider, connection, url: "https://example.com/mcp" }],
    ]);

    const factory = createCliAuthToolFactory({ servers, rediscover: async () => [] });
    const tools = factory(makeFailure("jira"));
    expect(tools[0]).toBeDefined();
    const result = await (tools[0] as (typeof tools)[number]).execute({});
    const content = result as {
      readonly content: readonly { readonly type: string; readonly text: string }[];
      readonly isError: boolean;
    };

    expect(content.isError).toBe(true);
    expect(content.content[0]?.text).toContain("failed");
    // Should NOT have tried to reconnect
    expect(connection.connect).not.toHaveBeenCalled();
  });

  test("authenticate execute handles reconnect failure gracefully", async () => {
    const provider = createMockAuthProvider({ startAuthFlowResult: true });
    const connection = createMockConnection("jira", {
      shouldFailConnect: true,
      connectErrorMessage: "Connection refused",
    });
    const servers = new Map<string, AuthServerEntry>([
      ["jira", { provider, connection, url: "https://example.com/mcp" }],
    ]);

    const factory = createCliAuthToolFactory({ servers, rediscover: async () => [] });
    const tools = factory(makeFailure("jira"));
    expect(tools[0]).toBeDefined();
    const result = await (tools[0] as (typeof tools)[number]).execute({});
    const content = result as {
      readonly content: readonly { readonly type: string; readonly text: string }[];
    };

    // Auth succeeded but reconnect failed — should still report partial success
    expect(content.content[0]?.text).toContain("reconnection");
    expect(content.content[0]?.text).toContain("failed");
  });
});
