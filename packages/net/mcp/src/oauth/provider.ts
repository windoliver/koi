/**
 * OAuth auth provider — implements McpAuthProvider with full OAuth 2.0 lifecycle.
 *
 * Delegates interactive steps (browser, callback) to the injected OAuthRuntime.
 * Manages token lifecycle: discovery → authorize → exchange → refresh → re-auth.
 */

import type { SecureStorage } from "@koi/secure-storage";
import type { McpAuthProvider } from "../auth.js";
import { discoverAuthServer } from "./discovery.js";
import { createPkceChallenge } from "./pkce.js";
import { registerDynamicClient } from "./registration.js";
import {
  computeClientKey,
  createTokenManager,
  readClientInfo,
  type TokenManager,
} from "./tokens.js";
import type {
  AuthServerMetadata,
  McpOAuthConfig,
  OAuthClientInfo,
  OAuthRuntime,
  OAuthTokens,
} from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthProviderOptions {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly oauthConfig: McpOAuthConfig;
  readonly runtime: OAuthRuntime;
  readonly storage: SecureStorage;
}

export interface OAuthAuthProvider extends McpAuthProvider {
  /** Run the full interactive OAuth authorization flow. */
  readonly startAuthFlow: () => Promise<boolean>;
  /** Clear stored tokens and trigger re-auth notification. */
  readonly handleUnauthorized: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CALLBACK_PORT = 8912;
const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an OAuth-backed McpAuthProvider.
 *
 * The provider's `token()` method returns the current access token,
 * refreshing automatically if expired. Returns `undefined` when no
 * tokens are stored (triggers auth-needed state in the connection).
 */
export function createOAuthAuthProvider(options: OAuthProviderOptions): OAuthAuthProvider {
  const { serverName, serverUrl, oauthConfig, runtime, storage } = options;

  const callbackPort = oauthConfig.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const redirectUri = `http://127.0.0.1:${callbackPort}/callback`;
  const resourceIndicator: string | undefined =
    oauthConfig.includeResourceParameter === false ? undefined : serverUrl;

  // Mutable state — justified: caches metadata + resolved client across token() calls
  let cachedMetadata: AuthServerMetadata | undefined;
  let cachedClient: OAuthClientInfo | undefined;
  let tokenManager: TokenManager | undefined;

  async function getMetadata(): Promise<AuthServerMetadata | undefined> {
    if (cachedMetadata !== undefined) return cachedMetadata;
    cachedMetadata = await discoverAuthServer(serverUrl, oauthConfig);
    return cachedMetadata;
  }

  /**
   * Resolve the effective OAuth client. Order:
   * 1. Configured `clientId` (static, no persistence)
   * 2. Persisted DCR result whose issuer + registration_endpoint still
   *    match the currently-discovered auth server
   * 3. Fresh DCR against the discovered `registration_endpoint`, persisted
   * Returns undefined when no client can be resolved — the caller fails closed.
   *
   * Steps 2/3 run under a single `withLock` on the client-info storage key
   * so concurrent flows cannot register two different clients and
   * overwrite each other — the token manager would otherwise refresh
   * against a different client than authorization used.
   */
  async function getClient(): Promise<OAuthClientInfo | undefined> {
    if (cachedClient !== undefined) return cachedClient;

    if (oauthConfig.clientId !== undefined) {
      cachedClient = { clientId: oauthConfig.clientId, registeredAt: 0 };
      return cachedClient;
    }

    const metadata = await getMetadata();
    const lockKey = computeClientKey(serverName, serverUrl);

    const resolved = await storage.withLock(lockKey, async () => {
      const stored = await readClientInfo(storage, serverName, serverUrl);
      if (stored !== undefined && isClientFresh(stored, metadata, redirectUri)) {
        return stored;
      }

      if (metadata?.registrationEndpoint === undefined) return undefined;

      const registered = await registerDynamicClient({
        registrationEndpoint: metadata.registrationEndpoint,
        redirectUri,
        clientName: serverName,
        issuer: metadata.issuer,
      });
      if (registered === undefined) return undefined;

      // writeClientInfo would re-enter withLock on the same key — we
      // already own it, so persist directly to avoid a self-deadlock.
      await storage.set(lockKey, JSON.stringify(registered));
      return registered;
    });

    if (resolved === undefined) return undefined;
    cachedClient = resolved;
    return cachedClient;
  }

  async function getTokenManager(): Promise<TokenManager> {
    if (tokenManager !== undefined) return tokenManager;
    const metadata = await getMetadata();
    const client = await getClient();
    tokenManager = createTokenManager({
      serverName,
      serverUrl,
      storage,
      metadata,
      clientId: client?.clientId,
      resource: resourceIndicator,
    });
    return tokenManager;
  }

  // --- McpAuthProvider.token() ---
  // McpAuthProvider.token returns `string | Promise<string> | undefined`.
  // Our async flow returns Promise<string | undefined>, which isn't directly
  // assignable. We use an explicit type annotation and cast the inner result —
  // at runtime, `await undefined` is fine and the transport handles it correctly.
  const token: McpAuthProvider["token"] = () => {
    return getTokenManager().then((tm) => tm.getAccessToken() as Promise<string>);
  };

  /**
   * Drop both the in-memory cache and the persisted record for a
   * dynamically-registered client so the next auth attempt re-runs DCR.
   * Used when the AS rejects the client during token exchange — left
   * unhandled, the bad client_id would survive `koi mcp logout` (which
   * deliberately keeps client-info) and trap the operator in a loop.
   */
  const invalidateRegisteredClient = async (): Promise<void> => {
    cachedClient = undefined;
    tokenManager = undefined;
    await storage.delete(computeClientKey(serverName, serverUrl));
  };

  // --- Interactive auth flow ---
  const startAuthFlow = async (): Promise<boolean> => {
    const metadata = await getMetadata();
    if (metadata === undefined) {
      return false;
    }

    const client = await getClient();
    if (client === undefined) {
      // No configured clientId AND no registration_endpoint to DCR against —
      // nothing we can do without operator intervention. Fail closed.
      return false;
    }

    const pkce = createPkceChallenge();

    // Build authorization URL (RFC 6749 + RFC 7636 PKCE + RFC 8707 resource)
    const authUrl = new URL(metadata.authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", client.clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("code_challenge", pkce.challenge);
    authUrl.searchParams.set("code_challenge_method", pkce.method);
    if (resourceIndicator !== undefined) {
      authUrl.searchParams.set("resource", resourceIndicator);
    }
    // Generate a random state parameter for CSRF protection
    const state = crypto.randomUUID();
    authUrl.searchParams.set("state", state);

    // Delegate to runtime for browser interaction
    const callbackResult = await runtime.authorize(authUrl.toString(), redirectUri);

    // Validate state parameter to prevent CSRF attacks
    if (callbackResult.state !== state) {
      return false;
    }

    // Exchange authorization code for tokens
    const tokens = await exchangeCode(
      callbackResult.code,
      pkce.verifier,
      redirectUri,
      metadata.tokenEndpoint,
      client.clientId,
      resourceIndicator,
    );

    if (tokens === undefined) {
      // Token exchange failed. If we used a dynamically-registered client
      // (registeredAt > 0), the AS may have revoked or lost it — there is
      // no normal recovery path because logout deliberately keeps the
      // client-info key. Drop the cached/persisted DCR client so the next
      // `koi mcp auth` re-registers from scratch instead of repeating the
      // failure with the same dead client_id.
      if (client.registeredAt > 0) {
        await invalidateRegisteredClient();
      }
      return false;
    }

    // Store tokens
    const tm = await getTokenManager();
    await tm.storeTokens(tokens);
    return true;
  };

  // --- 401 handling ---
  // On 401: try refreshing first (access token may have expired normally).
  // Only clear tokens and prompt re-auth if refresh also fails.
  const handleUnauthorized = async (): Promise<void> => {
    const tm = await getTokenManager();
    // Attempt to get a fresh access token via refresh
    const refreshed = await tm.getAccessToken();
    if (refreshed !== undefined) {
      // Refresh succeeded — the next reconnect will pick up the new token.
      // No need to clear tokens or prompt user.
      return;
    }
    // Refresh failed or no tokens — clear stale state and notify user
    await tm.clearTokens();
    await runtime.onReauthNeeded(serverName);
  };

  return {
    token,
    startAuthFlow,
    handleUnauthorized,
  };
}

// ---------------------------------------------------------------------------
// Client freshness
// ---------------------------------------------------------------------------

/**
 * Returns true when a persisted DCR client is still valid against the
 * currently-discovered auth server AND the provider's current
 * `redirectUri`. A stored record with no issuer / registration_endpoint /
 * redirectUri (shape predates this check, or static config was persisted
 * by mistake) is treated as fresh so upgrades do not force re-auth. Once
 * any binding is recorded, a mismatch is a migration event — re-register
 * rather than send a stale client_id to a different authorization server
 * or under a different redirect URI contract.
 */
function isClientFresh(
  stored: OAuthClientInfo,
  metadata: AuthServerMetadata | undefined,
  currentRedirectUri: string,
): boolean {
  if (
    stored.issuer === undefined &&
    stored.registrationEndpoint === undefined &&
    stored.redirectUri === undefined
  ) {
    return true;
  }
  if (metadata === undefined) return false;
  if (stored.issuer !== undefined && stored.issuer !== metadata.issuer) return false;
  if (
    stored.registrationEndpoint !== undefined &&
    stored.registrationEndpoint !== metadata.registrationEndpoint
  ) {
    return false;
  }
  if (stored.redirectUri !== undefined && stored.redirectUri !== currentRedirectUri) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  tokenEndpoint: string,
  clientId: string,
  resource: string | undefined,
): Promise<OAuthTokens | undefined> {
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: clientId,
    });
    // RFC 8707: bind the issued token to the MCP server URL when enabled.
    // Operators can opt out via `oauth.includeResourceParameter: false` for
    // legacy authorization servers that reject `resource`.
    if (resource !== undefined) {
      body.set("resource", resource);
    }

    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });

    if (!response.ok) return undefined;

    const data = (await response.json()) as {
      readonly access_token?: string;
      readonly refresh_token?: string;
      readonly expires_in?: number;
      readonly token_type?: string;
      readonly scope?: string;
    };

    if (typeof data.access_token !== "string") return undefined;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt:
        typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
      tokenType: data.token_type,
      scope: data.scope,
    };
  } catch {
    return undefined;
  }
}
