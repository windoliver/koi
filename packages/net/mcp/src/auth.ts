/**
 * MCP authentication provider interface.
 *
 * Pluggable auth for MCP transports. The transport calls token() before
 * each request to get the current bearer token.
 *
 * This is intentionally sync-only. Async token refresh (OAuth 2.1, token
 * rotation) and 401/403 retry are not yet implemented — they will be added
 * in a future PR with a separate AsyncMcpAuthProvider interface. Keeping
 * the contract narrow prevents callers from depending on unimplemented behavior.
 */

// ---------------------------------------------------------------------------
// Auth provider interface
// ---------------------------------------------------------------------------

/**
 * Synchronous authentication provider for MCP transports.
 *
 * - `token()`: returns the current auth token (bearer, API key, etc.)
 *   Return `undefined` to skip authentication for this request.
 *
 * For async token refresh or OAuth 2.1 flows, a future AsyncMcpAuthProvider
 * will extend this interface.
 */
export interface McpAuthProvider {
  readonly token: () => string | undefined;
}

// ---------------------------------------------------------------------------
// Built-in: static bearer token provider
// ---------------------------------------------------------------------------

/**
 * Creates a simple auth provider that returns a static bearer token.
 * Useful for API-key-based MCP servers.
 */
export function createBearerAuthProvider(bearerToken: string): McpAuthProvider {
  return {
    token: () => bearerToken,
  };
}
