/**
 * MCP authentication provider interface.
 *
 * Pluggable auth for MCP transports. The transport calls token() before
 * each request and onUnauthorized() when it receives a 401/403.
 *
 * Simple bearer token providers implement token() only.
 * OAuth 2.1 providers implement the full interface (future package).
 */

// ---------------------------------------------------------------------------
// Auth provider interface
// ---------------------------------------------------------------------------

export interface UnauthorizedContext {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly serverName: string;
}

/**
 * Pluggable authentication provider for MCP transports.
 *
 * - `token()`: returns the current auth token (bearer, API key, etc.)
 *   Return `undefined` to skip authentication for this request.
 * - `onUnauthorized()`: called when the transport receives a 401 or 403.
 *   The provider should refresh/rotate credentials. If it returns without
 *   error, the transport retries the request once.
 */
export interface McpAuthProvider {
  readonly token: () => string | undefined | Promise<string | undefined>;
  readonly onUnauthorized?: (context: UnauthorizedContext) => void | Promise<void>;
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
