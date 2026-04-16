/**
 * OAuth-aware MCP connection factory.
 *
 * Wraps createMcpConnection to automatically attach an OAuthAuthProvider
 * when the server config has an `oauth` field and stored tokens exist.
 * Used by tui-runtime, start command, and mcp CLI commands.
 */

import type { McpConnection, McpServerConfig, OAuthAuthProvider } from "@koi/mcp";
import { createMcpConnection, createOAuthAuthProvider, resolveServerConfig } from "@koi/mcp";
import { createSecureStorage } from "@koi/secure-storage";
import { createCliOAuthRuntime } from "./commands/mcp-oauth-runtime.js";

/**
 * Creates an MCP connection, attaching an OAuth auth provider when the
 * server config includes an `oauth` field.
 *
 * When `authProviderSink` is provided, stores the auth provider keyed
 * by server name so the auth tool factory can access it later.
 */
export function createOAuthAwareMcpConnection(
  server: McpServerConfig,
  authProviderSink?: Map<string, OAuthAuthProvider>,
): McpConnection {
  const resolved = resolveServerConfig(server);

  if (server.kind === "http" && server.oauth !== undefined) {
    // Fail closed: if secure storage is unavailable, surface the error
    // rather than silently connecting without credentials (which would
    // cause opaque 401s instead of a clear platform error).
    const storage = createSecureStorage();
    const runtime = createCliOAuthRuntime();
    const provider = createOAuthAuthProvider({
      serverName: server.name,
      serverUrl: server.url,
      oauthConfig: server.oauth,
      runtime,
      storage,
    });

    authProviderSink?.set(server.name, provider);

    return createMcpConnection(resolved, provider, {
      onUnauthorized: () => provider.handleUnauthorized(),
    });
  }

  return createMcpConnection(resolved);
}
