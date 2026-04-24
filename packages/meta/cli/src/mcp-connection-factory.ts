/**
 * OAuth-aware MCP connection factory.
 *
 * Wraps createMcpConnection to automatically attach an OAuthAuthProvider
 * when the server config has an `oauth` field and stored tokens exist.
 * Used by tui-runtime, start command, and mcp CLI commands.
 */

import type { OAuthChannel } from "@koi/core";
import type { McpConnection, McpServerConfig, OAuthAuthProvider } from "@koi/mcp";
import { createMcpConnection, createOAuthAuthProvider, resolveServerConfig } from "@koi/mcp";
import { createSecureStorage } from "@koi/secure-storage";
import { createCliOAuthRuntime } from "./commands/mcp-oauth-runtime.js";

/** Injectable factories for testing. All fields are optional — defaults are the real implementations. */
export interface OAuthAwareMcpConnectionDeps {
  readonly createConnection?: typeof createMcpConnection;
  readonly createAuthProvider?: typeof createOAuthAuthProvider;
  readonly createStorage?: typeof createSecureStorage;
  readonly createRuntime?: typeof createCliOAuthRuntime;
}

/**
 * Creates an MCP connection, attaching an OAuth auth provider when the
 * server config includes an `oauth` field.
 *
 * When `authProviderSink` is provided, stores the auth provider keyed
 * by server name so the auth tool factory can access it later.
 *
 * When `oauthChannel` is provided and the server requires OAuth, wires
 * `onAuthNeeded` so that mid-session 401s trigger the interactive auth
 * flow via the channel and reconnect automatically on success.
 */
export function createOAuthAwareMcpConnection(
  server: McpServerConfig,
  authProviderSink?: Map<string, OAuthAuthProvider> | undefined,
  oauthChannel?: OAuthChannel | undefined,
  deps?: OAuthAwareMcpConnectionDeps | undefined,
): McpConnection {
  const {
    createConnection = createMcpConnection,
    createAuthProvider = createOAuthAuthProvider,
    createStorage = createSecureStorage,
    createRuntime = createCliOAuthRuntime,
  } = deps ?? {};

  const resolved = resolveServerConfig(server);

  if (server.kind === "http" && server.oauth !== undefined) {
    // Fail closed: if secure storage is unavailable, surface the error
    // rather than silently connecting without credentials (which would
    // cause opaque 401s instead of a clear platform error).
    const storage = createStorage();
    const runtime = createRuntime();
    const provider = createAuthProvider({
      serverName: server.name,
      serverUrl: server.url,
      oauthConfig: server.oauth,
      runtime,
      storage,
    });

    authProviderSink?.set(server.name, provider);

    const onAuthNeeded =
      oauthChannel !== undefined
        ? async (): Promise<boolean> => {
            // Fire-and-forget — renderer latency or failure must never block
            // the browser window from opening. startAuthFlow() starts immediately.
            void Promise.resolve(
              oauthChannel.onAuthRequired({
                provider: server.name,
                message: `${server.name} requires authorization`,
                mode: "local",
              }),
            ).catch(() => {});
            const authed = await provider.startAuthFlow();
            // Notify best-effort — auth is already done regardless.
            if (authed) {
              await Promise.resolve(oauthChannel.onAuthComplete({ provider: server.name })).catch(
                () => {},
              );
            }
            return authed;
          }
        : undefined;

    return createConnection(resolved, provider, {
      onUnauthorized: () => provider.handleUnauthorized(),
      ...(onAuthNeeded !== undefined ? { onAuthNeeded } : {}),
    });
  }

  return createConnection(resolved);
}
