/**
 * MCP authentication provider interface.
 *
 * Pluggable auth for MCP transports. The transport calls token() before
 * each request to get the current bearer token.
 *
 * Returns `string | Promise<string> | undefined` so implementations can be
 * sync (static bearer token) or async (OAuth 2.1 token refresh) without
 * interface changes. Callers must always `await` the result.
 */

// ---------------------------------------------------------------------------
// Auth provider interface
// ---------------------------------------------------------------------------

/**
 * Authentication provider for MCP transports.
 *
 * - `token()`: returns the current auth token (bearer, API key, etc.)
 *   Return `undefined` to skip authentication for this request.
 *   May return a Promise for async token retrieval (OAuth 2.1, rotation).
 */
export interface McpAuthProvider {
  readonly token: () => string | Promise<string> | undefined;
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
