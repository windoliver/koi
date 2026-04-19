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
  /**
   * RFC 8707 `resource` parameter. Defaults to `true` (spec-compliant MCP
   * 2025-03-26). Set `false` for legacy authorization servers that reject
   * the `resource` parameter with `invalid_target`/`invalid_request` —
   * operators can then opt out on a per-server basis rather than hitting
   * an unrecoverable auth failure.
   */
  readonly includeResourceParameter?: boolean | undefined;
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
/** Result from the OAuth callback containing code and state for validation. */
export interface OAuthCallbackResult {
  readonly code: string;
  readonly state: string | undefined;
}

export interface OAuthRuntime {
  /**
   * Open the authorization URL in a browser and wait for the redirect callback.
   * Returns the authorization code and state parameter from the callback.
   *
   * @param authorizationUrl - Full OAuth authorization URL with PKCE challenge
   * @param redirectUri - The callback URI the auth server will redirect to
   */
  readonly authorize: (
    authorizationUrl: string,
    redirectUri: string,
  ) => Promise<OAuthCallbackResult>;

  /**
   * Notify the user that re-authentication is needed (e.g., after 401 mid-session).
   * The host decides how to present this (TUI prompt, CLI message, etc.).
   */
  readonly onReauthNeeded: (serverName: string) => Promise<void>;

  /**
   * Optional structured-failure observer. Fires when the provider takes a
   * fail-closed branch — discovery failure, DCR rejection (insecure
   * endpoint, confidential client, narrowed redirect_uris, missing
   * registration_endpoint), or token-exchange failure. Lets hosts surface
   * actionable diagnostics instead of a generic "auth failed" message.
   * Implementations MUST NOT throw — failures here cannot affect the
   * underlying auth flow.
   */
  readonly onAuthFailure?: ((reason: OAuthFailureReason) => void) | undefined;
}

/** Discriminated failure reasons for `OAuthRuntime.onAuthFailure`. */
export type OAuthFailureReason =
  | { readonly kind: "discovery_failed"; readonly serverName: string }
  | { readonly kind: "dcr_unavailable"; readonly serverName: string }
  | { readonly kind: "dcr_failed"; readonly serverName: string; readonly detail: string }
  | {
      readonly kind: "exchange_failed";
      readonly serverName: string;
      readonly invalidClient: boolean;
    }
  | { readonly kind: "state_mismatch"; readonly serverName: string };

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

/**
 * Persisted OAuth client info — produced by configured `clientId` or by
 * Dynamic Client Registration (RFC 7591). Stored separately from tokens
 * so `koi mcp logout` does not force re-registration.
 *
 * Registered records carry the `issuer` and `registrationEndpoint` they
 * were created under so a later change to discovery (different auth
 * server) invalidates the cached client instead of silently using a
 * client id against the wrong issuer.
 */
export interface OAuthClientInfo {
  readonly clientId: string;
  /** Epoch ms when the client was persisted. 0 for configured static clients. */
  readonly registeredAt: number;
  /** Issuer the client was registered with (DCR only). Absent for configured static clients. */
  readonly issuer?: string | undefined;
  /** Registration endpoint used (DCR only). Absent for configured static clients. */
  readonly registrationEndpoint?: string | undefined;
}
