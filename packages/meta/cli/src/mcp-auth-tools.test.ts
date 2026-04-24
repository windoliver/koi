import { describe, expect, mock, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { McpConnection, McpServerFailure, OAuthAuthProvider } from "@koi/mcp";
import type { AuthServerEntry } from "./mcp-auth-tools.js";
import { createCliAuthToolFactory } from "./mcp-auth-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAuthProvider(): OAuthAuthProvider {
  return {
    token: () => undefined,
    startAuthFlow: mock(async () => true),
    handleUnauthorized: mock(async () => "refreshed" as const),
  };
}

type TriggerAuthBehavior = "success" | "auth-declined" | "connect-failed" | "error-result";

function createMockConnection(
  name: string,
  triggerAuthBehavior: TriggerAuthBehavior = "success",
): McpConnection {
  const triggerAuth = mock(async (): Promise<Result<void, KoiError>> => {
    if (triggerAuthBehavior === "auth-declined") {
      return {
        ok: false,
        error: {
          code: "AUTH_REQUIRED",
          message: "Authorization was cancelled or failed. Retry via the /mcp panel.",
          retryable: false,
          context: { serverName: name },
        },
      };
    }
    if (triggerAuthBehavior === "connect-failed") {
      return {
        ok: false,
        error: { code: "EXTERNAL", message: "Connection refused", retryable: false },
      };
    }
    if (triggerAuthBehavior === "error-result") {
      return {
        ok: false,
        error: {
          code: "AUTH_REQUIRED",
          message: `${name}: auth flow failed — callback port 8912 already in use`,
          retryable: true,
          context: { serverName: name },
        },
      };
    }
    return { ok: true, value: undefined };
  });

  return {
    serverName: name,
    state: { kind: "idle" as const },
    connect: mock(async () => ({ ok: true as const, value: undefined })),
    listTools: mock(async () => ({ ok: true as const, value: [] as const })),
    callTool: mock(async () => ({ ok: true as const, value: undefined })),
    close: mock(async () => {}),
    reconnect: mock(async () => ({ ok: true as const, value: undefined })),
    onStateChange: () => () => {},
    onToolsChanged: () => () => {},
    triggerAuth,
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

  test("authenticate tool description includes server name but never URL/hostname", () => {
    const provider = createMockAuthProvider();
    const connection = createMockConnection("jira");
    const servers = new Map<string, AuthServerEntry>([
      ["jira", { provider, connection, url: "https://maas.example.com/jira/mcp" }],
    ]);

    const factory = createCliAuthToolFactory({ servers, rediscover: async () => [] });
    const tools = factory(makeFailure("jira"));

    const desc = tools[0]?.descriptor.description ?? "";
    expect(desc).toContain('"jira"');
    // URL/hostname must not leak to model-visible descriptor
    expect(desc).not.toContain("https://");
    expect(desc).not.toContain("maas.example.com");
    expect(desc).not.toContain("/jira/mcp");
    expect(desc).toContain("authentication");
  });

  test("returns empty array for unknown server", () => {
    const servers = new Map<string, AuthServerEntry>();
    const factory = createCliAuthToolFactory({ servers, rediscover: async () => [] });
    const tools = factory(makeFailure("unknown"));

    expect(tools).toHaveLength(0);
  });

  test("authenticate execute routes through triggerAuth and rediscovers on success", async () => {
    const provider = createMockAuthProvider();
    const connection = createMockConnection("jira", "success");
    const rediscover = mock(async () => []);
    const servers = new Map<string, AuthServerEntry>([
      ["jira", { provider, connection, url: "https://example.com/mcp" }],
    ]);

    const factory = createCliAuthToolFactory({ servers, rediscover });
    const tools = factory(makeFailure("jira"));
    expect(tools[0]).toBeDefined();

    const result = await (tools[0] as (typeof tools)[number]).execute({});
    const content = result as {
      readonly content: readonly { readonly type: string; readonly text: string }[];
    };

    expect(connection.triggerAuth).toHaveBeenCalledTimes(1);
    // connect/startAuthFlow must NOT be called directly from execute
    expect(connection.connect).not.toHaveBeenCalled();
    expect(rediscover).toHaveBeenCalledTimes(1);
    expect(content.content[0]?.text).toContain("successful");
  });

  test("authenticate execute returns error when triggerAuth returns auth-declined", async () => {
    const provider = createMockAuthProvider();
    const connection = createMockConnection("jira", "auth-declined");
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
  });

  test("authenticate execute returns error when triggerAuth returns connect-failed", async () => {
    const provider = createMockAuthProvider();
    const connection = createMockConnection("jira", "connect-failed");
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
    expect(content.content[0]?.text).toContain("Connection refused");
    expect(content.content[0]?.text).toContain("koi mcp auth jira");
  });

  test("authenticate execute returns error when connection has no triggerAuth", async () => {
    const provider = createMockAuthProvider();
    const connection = createMockConnection("jira", "success");
    // Simulate a connection without triggerAuth (non-OAuth or legacy)
    const connectionWithoutTrigger = { ...connection, triggerAuth: undefined };
    const servers = new Map<string, AuthServerEntry>([
      [
        "jira",
        {
          provider,
          connection: connectionWithoutTrigger as unknown as McpConnection,
          url: "https://example.com/mcp",
        },
      ],
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
    expect(content.content[0]?.text).toContain("not available");
    expect(content.content[0]?.text).toContain("koi mcp auth jira");
  });

  test("authenticate execute surfaces auth flow errors returned by triggerAuth", async () => {
    const provider = createMockAuthProvider();
    const connection = createMockConnection("jira", "error-result");
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
    expect(content.content[0]?.text).toContain("callback port 8912 already in use");
    expect(content.content[0]?.text).toContain("koi mcp auth jira");
  });
});
