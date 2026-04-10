/**
 * OAuth types for MCP authentication.
 *
 * OAuthRuntime is the injection point: @koi/mcp defines it,
 * CLI (or other hosts) implement it. This keeps browser launch,
 * callback server, and user interaction out of the transport library.
 */

// ---------------------------------------------------------------------------
// OAuth config (from .mcp.json)
// ---------------------------------------------------------------------------

/** OAuth configuration from the external MCP server config. */
export interface McpOAuthConfig {
  readonly clientId?: string | undefined;
  readonly callbackPort?: number | undefined;
  readonly authServerMetadataUrl?: string | undefined;
}

// ---------------------------------------------------------------------------
// OAuth runtime (injected by host — CLI, TUI, etc.)
// ---------------------------------------------------------------------------

/**
 * Interactive OAuth runtime — injected by the host application.
 *
 * @koi/mcp calls these methods when user interaction is needed.
 * The CLI implements them with browser launch + local HTTP callback server.
 */
export interface OAuthRuntime {
  /**
   * Open the authorization URL in a browser and wait for the redirect callback.
   * Returns the authorization code from the callback.
   *
   * @param authorizationUrl - Full OAuth authorization URL with PKCE challenge
   * @param redirectUri - The callback URI the auth server will redirect to
   */
  readonly authorize: (authorizationUrl: string, redirectUri: string) => Promise<string>;

  /**
   * Notify the user that re-authentication is needed (e.g., after 401 mid-session).
   * The host decides how to present this (TUI prompt, CLI message, etc.).
   */
  readonly onReauthNeeded: (serverName: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

/** Persisted OAuth token set. */
export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly expiresAt?: number | undefined;
  readonly tokenType?: string | undefined;
  readonly scope?: string | undefined;
}

/** Authorization server metadata (subset of RFC 8414). */
export interface AuthServerMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string | undefined;
  readonly codeChallengeMethodsSupported?: readonly string[] | undefined;
}
