import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { OAuthChannel } from "@koi/core";
import type { McpConnection, McpServerConfig, OAuthAuthProvider } from "@koi/mcp";
import type { OAuthAwareMcpConnectionDeps } from "./mcp-connection-factory.js";
import { createOAuthAwareMcpConnection } from "./mcp-connection-factory.js";

type SpiedConnectionDeps = {
  readonly onUnauthorized?: unknown;
  readonly onAuthNeeded?: unknown;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStdioServer(): McpServerConfig {
  return { kind: "stdio", name: "test-stdio", command: "echo", args: [] };
}

function makeHttpOauthServer(): McpServerConfig & { kind: "http" } {
  return {
    kind: "http",
    name: "test-http",
    url: "https://example.com/mcp",
    oauth: {
      clientId: "client-id",
      authorizationEndpoint: "https://example.com/auth",
      tokenEndpoint: "https://example.com/token",
    },
  } as unknown as McpServerConfig & { kind: "http" };
}

function makeProvider(startAuthFlowResult = true): OAuthAuthProvider {
  return {
    getToken: mock(async () => undefined),
    handleUnauthorized: mock(async () => {}),
    startAuthFlow: mock(async () => startAuthFlowResult),
  } as unknown as OAuthAuthProvider;
}

function makeMcpConnection(): McpConnection {
  return {
    tools: mock(() => []),
    call: mock(async () => ({ content: [], isError: false })),
    connect: mock(async () => {}),
    disconnect: mock(async () => {}),
    isConnected: mock(() => false),
    onToolsChanged: mock(() => () => {}),
  } as unknown as McpConnection;
}

function makeOAuthChannel(): OAuthChannel {
  return {
    onAuthRequired: mock(async () => {}),
    onAuthComplete: mock(async () => {}),
    submitAuthCode: mock(() => {}),
  };
}

type MockDeps = {
  readonly createConnection: ReturnType<typeof mock>;
  readonly createAuthProvider: ReturnType<typeof mock>;
  readonly createStorage: ReturnType<typeof mock>;
  readonly createRuntime: ReturnType<typeof mock>;
  readonly provider: OAuthAuthProvider;
  readonly connection: McpConnection;
};

function makeDeps(overrides?: { provider?: OAuthAuthProvider }): MockDeps {
  const provider = overrides?.provider ?? makeProvider();
  const connection = makeMcpConnection();
  return {
    provider,
    connection,
    createConnection: mock(() => connection),
    createAuthProvider: mock(() => provider),
    createStorage: mock(() => ({})),
    createRuntime: mock(() => ({})),
  };
}

function toDeps(mocks: MockDeps): OAuthAwareMcpConnectionDeps {
  return {
    createConnection: mocks.createConnection as unknown as NonNullable<
      OAuthAwareMcpConnectionDeps["createConnection"]
    >,
    createAuthProvider: mocks.createAuthProvider as unknown as NonNullable<
      OAuthAwareMcpConnectionDeps["createAuthProvider"]
    >,
    createStorage: mocks.createStorage as unknown as NonNullable<
      OAuthAwareMcpConnectionDeps["createStorage"]
    >,
    createRuntime: mocks.createRuntime as unknown as NonNullable<
      OAuthAwareMcpConnectionDeps["createRuntime"]
    >,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOAuthAwareMcpConnection", () => {
  let mocks: MockDeps;

  beforeEach(() => {
    mocks = makeDeps();
  });

  describe("non-HTTP server", () => {
    test("calls createConnection without auth provider or onAuthNeeded", () => {
      const server = makeStdioServer();
      createOAuthAwareMcpConnection(server, undefined, undefined, toDeps(mocks));

      expect(mocks.createConnection).toHaveBeenCalledTimes(1);
      expect(mocks.createAuthProvider).not.toHaveBeenCalled();
      // Only one arg: no provider, no deps
      const callArgs = mocks.createConnection.mock.calls[0] as unknown[];
      expect(callArgs).toHaveLength(1);
    });
  });

  describe("HTTP + oauth server, no oauthChannel", () => {
    test("calls createConnection with onUnauthorized but no onAuthNeeded", () => {
      const server = makeHttpOauthServer();
      createOAuthAwareMcpConnection(server, undefined, undefined, toDeps(mocks));

      expect(mocks.createConnection).toHaveBeenCalledTimes(1);
      expect(mocks.createAuthProvider).toHaveBeenCalledTimes(1);
      const callArgs = mocks.createConnection.mock.calls[0] as [
        unknown,
        unknown,
        SpiedConnectionDeps,
      ];
      const connectionDeps = callArgs[2];
      expect(typeof connectionDeps.onUnauthorized).toBe("function");
      expect(connectionDeps.onAuthNeeded).toBeUndefined();
    });
  });

  describe("HTTP + oauth server, with oauthChannel", () => {
    test("calls createConnection with both onUnauthorized and onAuthNeeded", () => {
      const server = makeHttpOauthServer();
      const oauthChannel = makeOAuthChannel();
      createOAuthAwareMcpConnection(server, undefined, oauthChannel, toDeps(mocks));

      expect(mocks.createConnection).toHaveBeenCalledTimes(1);
      const callArgs = mocks.createConnection.mock.calls[0] as [
        unknown,
        unknown,
        SpiedConnectionDeps,
      ];
      const connectionDeps = callArgs[2];
      expect(typeof connectionDeps.onUnauthorized).toBe("function");
      expect(typeof connectionDeps.onAuthNeeded).toBe("function");
    });
  });

  describe("authProviderSink", () => {
    test("sets provider in sink keyed by server name when sink provided", () => {
      const server = makeHttpOauthServer();
      const sink = new Map<string, OAuthAuthProvider>();
      createOAuthAwareMcpConnection(server, sink, undefined, toDeps(mocks));

      expect(sink.has("test-http")).toBe(true);
      expect(sink.get("test-http")).toBe(mocks.provider);
    });

    test("does not set anything in sink for non-OAuth server", () => {
      const server = makeStdioServer();
      const sink = new Map<string, OAuthAuthProvider>();
      createOAuthAwareMcpConnection(server, sink, undefined, toDeps(mocks));

      expect(sink.size).toBe(0);
    });
  });

  describe("onAuthNeeded callback behavior", () => {
    function extractOnAuthNeeded(
      oauthChannel: OAuthChannel,
      provider?: OAuthAuthProvider,
    ): (() => Promise<boolean>) | undefined {
      const localMocks = makeDeps(provider !== undefined ? { provider } : undefined);
      const server = makeHttpOauthServer();
      createOAuthAwareMcpConnection(server, undefined, oauthChannel, toDeps(localMocks));
      const callArgs = localMocks.createConnection.mock.calls[0] as [
        unknown,
        unknown,
        SpiedConnectionDeps,
      ];
      return callArgs[2]?.onAuthNeeded as (() => Promise<boolean>) | undefined;
    }

    test("calls startAuthFlow then onAuthComplete when authed=true", async () => {
      const oauthChannel = makeOAuthChannel();
      const provider = makeProvider(true);
      const onAuthNeeded = extractOnAuthNeeded(oauthChannel, provider);
      expect(onAuthNeeded).toBeDefined();
      if (onAuthNeeded === undefined) return;

      const result = await onAuthNeeded();

      const startFlow = provider.startAuthFlow as ReturnType<typeof mock>;
      expect(startFlow).toHaveBeenCalledTimes(1);
      expect(oauthChannel.onAuthComplete).toHaveBeenCalledTimes(1);
      const completeArg = (oauthChannel.onAuthComplete as ReturnType<typeof mock>).mock
        .calls[0]?.[0] as { provider: string };
      expect(completeArg.provider).toBe("test-http");

      expect(result).toBe(true);
    });

    test("calls startAuthFlow but NOT onAuthComplete when authed=false", async () => {
      const oauthChannel = makeOAuthChannel();
      const provider = makeProvider(false);
      const onAuthNeeded = extractOnAuthNeeded(oauthChannel, provider);
      expect(onAuthNeeded).toBeDefined();
      if (onAuthNeeded === undefined) return;

      const result = await onAuthNeeded();

      const startFlow = provider.startAuthFlow as ReturnType<typeof mock>;
      expect(startFlow).toHaveBeenCalledTimes(1);
      expect(oauthChannel.onAuthComplete).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });

    test("wires onBrowserOpen to fire onAuthRequired with URL through channel", () => {
      const oauthChannel = makeOAuthChannel();
      const localMocks = makeDeps();
      const server = makeHttpOauthServer();
      createOAuthAwareMcpConnection(server, undefined, oauthChannel, toDeps(localMocks));

      // createRuntime must have been called with an onBrowserOpen option
      const runtimeCallArgs = localMocks.createRuntime.mock.calls[0] as [
        { onBrowserOpen?: (url: string) => void } | undefined,
      ];
      const onBrowserOpen = runtimeCallArgs?.[0]?.onBrowserOpen;
      expect(typeof onBrowserOpen).toBe("function");
      if (onBrowserOpen === undefined) return;

      // Simulate the runtime calling onBrowserOpen with an auth URL
      const fakeUrl = "https://example.com/oauth/authorize?client_id=x&...";
      onBrowserOpen(fakeUrl);

      // channel.onAuthRequired must have been fired with the URL
      expect(oauthChannel.onAuthRequired).toHaveBeenCalledTimes(1);
      const reqArg = (oauthChannel.onAuthRequired as ReturnType<typeof mock>).mock
        .calls[0]?.[0] as { provider: string; authUrl: string; mode: string };
      expect(reqArg.provider).toBe("test-http");
      expect(reqArg.authUrl).toBe(fakeUrl);
      expect(reqArg.mode).toBe("local");
    });
  });
});
