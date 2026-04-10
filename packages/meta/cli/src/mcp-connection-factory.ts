/**
 * OAuth-aware MCP connection factory.
 *
 * Wraps createMcpConnection to automatically attach an OAuthAuthProvider
 * when the server config has an `oauth` field and stored tokens exist.
 * Used by tui-runtime, start command, and mcp CLI commands.
 */

import type { McpConnection, McpServerConfig } from "@koi/mcp";
import { createMcpConnection, createOAuthAuthProvider, resolveServerConfig } from "@koi/mcp";
import { createSecureStorage } from "@koi/secure-storage";
import { createCliOAuthRuntime } from "./commands/mcp-oauth-runtime.js";

/**
 * Creates an MCP connection, attaching an OAuth auth provider when the
 * server config includes an `oauth` field.
 */
export function createOAuthAwareMcpConnection(server: McpServerConfig): McpConnection {
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

    return createMcpConnection(resolved, provider, {
      onUnauthorized: () => provider.handleUnauthorized(),
    });
  }

  return createMcpConnection(resolved);
}
