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
   * 1. Configured `clientId` (static — safe to memoize, never changes)
   * 2. Persisted DCR result whose issuer + registration_endpoint still
   *    match the currently-discovered auth server
   * 3. Fresh DCR against the discovered `registration_endpoint`, persisted
   * Returns undefined when no client can be resolved — the caller fails closed.
   *
   * For the DCR path we deliberately do NOT memoize: two provider
   * instances pointing at the same MCP URL share one persisted client
   * record (`computeClientKey` is name-independent). If one instance
   * invalidates and re-registers the shared client, the other must
   * pick up the repaired record on its next call rather than serve a
   * stale in-memory copy. The withLock + storage round-trip is sub-ms
   * for keychain reads — caching here is not worth the split-brain risk.
   *
   * Steps 2/3 run under a single `withLock` on the client-info storage
   * key so concurrent flows cannot register two different clients and
   * overwrite each other.
   */
  async function getClient(): Promise<OAuthClientInfo | undefined> {
    if (oauthConfig.clientId !== undefined) {
      if (cachedClient === undefined) {
        cachedClient = { clientId: oauthConfig.clientId, registeredAt: 0 };
      }
      return cachedClient;
    }

    const metadata = await getMetadata();
    const lockKey = computeClientKey(serverName, serverUrl, redirectUri);

    const resolved = await storage.withLock(lockKey, async () => {
      const stored = await readClientInfo(storage, serverName, serverUrl, redirectUri);
      if (stored !== undefined && isClientFresh(stored, metadata)) {
        return stored;
      }

      if (metadata?.registrationEndpoint === undefined) return undefined;

      // registerDynamicClient throws on a non-HTTPS registration_endpoint
      // (it refuses to send registration credentials over cleartext).
      // Convert that into a fail-closed undefined so the rest of the
      // auth flow returns false instead of crashing through the provider.
      let registered: OAuthClientInfo | undefined;
      try {
        registered = await registerDynamicClient({
          registrationEndpoint: metadata.registrationEndpoint,
          redirectUri,
          clientName: serverName,
          issuer: metadata.issuer,
        });
      } catch {
        return undefined;
      }
      if (registered === undefined) return undefined;

      // writeClientInfo would re-enter withLock on the same key — we
      // already own it, so persist directly to avoid a self-deadlock.
      await storage.set(lockKey, JSON.stringify(registered));
      return registered;
    });

    // Refresh the in-memory cache so onInvalidClient + post-revocation
    // checks see the current binding, but do NOT short-circuit the next
    // getClient call on it — see freshness rationale above.
    cachedClient = resolved;
    return resolved;
  }

  async function getTokenManager(): Promise<TokenManager> {
    if (tokenManager !== undefined) return tokenManager;
    const metadata = await getMetadata();
    tokenManager = createTokenManager({
      serverName,
      serverUrl,
      storage,
      metadata,
      resource: resourceIndicator,
      // Lazy: a passive `token()` call with no stored tokens must NOT
      // trigger DCR. Resolution fires only inside the refresh path,
      // when there is actually a token set worth rotating.
      getClientId: async () => {
        const client = await getClient();
        return client?.clientId;
      },
      // Forward refresh-time invalid_client signals to the DCR
      // invalidator. Only invalidates when the cached client is DCR
      // (registeredAt > 0); CAS on its clientId so a stale flow cannot
      // delete a newer registration another process already repaired.
      onInvalidClient: async () => {
        if (cachedClient !== undefined && cachedClient.registeredAt > 0) {
          await invalidateRegisteredClient(cachedClient.clientId);
        }
      },
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
   * CAS-gated on the `expectedClientId` that actually failed: a stale
   * flow that started before another process repaired the shared record
   * MUST NOT erase the newer valid registration. If the persisted
   * clientId no longer matches what we used, only the in-memory cache
   * is dropped — the next getClient call will pick up the fresh record.
   */
  const invalidateRegisteredClient = async (expectedClientId: string): Promise<void> => {
    cachedClient = undefined;
    tokenManager = undefined;
    const lockKey = computeClientKey(serverName, serverUrl, redirectUri);
    await storage.withLock(lockKey, async () => {
      const current = await readClientInfo(storage, serverName, serverUrl, redirectUri);
      if (current !== undefined && current.clientId === expectedClientId) {
        await storage.delete(lockKey);
      }
    });
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
    const exchange = await exchangeCode(
      callbackResult.code,
      pkce.verifier,
      redirectUri,
      metadata.tokenEndpoint,
      client.clientId,
      resourceIndicator,
    );

    if (!exchange.ok) {
      // Only invalidate the persisted DCR client on an explicit
      // `invalid_client` signal — transient 5xx, timeouts, malformed
      // responses, or non-client errors must not destroy a healthy
      // registration. CAS on the failing clientId so a stale flow
      // cannot wipe a newer registration another process already wrote.
      if (exchange.invalidClient && client.registeredAt > 0) {
        await invalidateRegisteredClient(client.clientId);
      }
      return false;
    }

    // Store tokens
    const tm = await getTokenManager();
    await tm.storeTokens(exchange.tokens);
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
 * currently-discovered auth server. The `redirectUri` contract is
 * already enforced by the storage key (see `computeClientKey`) so two
 * configs with different callback ports get independent records rather
 * than fighting over one.
 *
 * DCR records (`registeredAt > 0`) MUST carry both issuer and
 * registration_endpoint bindings — anything else is legacy/unbound
 * persistence from an earlier shape, and reusing it would silently
 * send a stale `client_id` to whatever AS discovery now points at.
 * Treat unbound DCR records as stale so the next auth attempt
 * re-registers cleanly. Static records (`registeredAt === 0`) carry
 * no bindings by design; their `clientId` is operator-managed and
 * always fresh.
 */
function isClientFresh(stored: OAuthClientInfo, metadata: AuthServerMetadata | undefined): boolean {
  if (stored.registeredAt === 0) return true;
  if (metadata === undefined) return false;
  if (stored.issuer === undefined || stored.registrationEndpoint === undefined) return false;
  if (stored.issuer !== metadata.issuer) return false;
  if (stored.registrationEndpoint !== metadata.registrationEndpoint) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/**
 * Typed result for the authorization-code → token exchange. The
 * `invalidClient` flag distinguishes a server-side client revocation
 * from any other failure (transient 5xx, timeout, malformed response,
 * resource rejection) so the provider can self-heal a revoked DCR
 * client without churning healthy registrations on unrelated outages.
 */
type ExchangeResult =
  | { readonly ok: true; readonly tokens: OAuthTokens }
  | { readonly ok: false; readonly invalidClient: boolean };

async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  tokenEndpoint: string,
  clientId: string,
  resource: string | undefined,
): Promise<ExchangeResult> {
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

    if (!response.ok) {
      const invalidClient = await isInvalidClientResponse(response);
      return { ok: false, invalidClient };
    }

    const data = (await response.json()) as {
      readonly access_token?: string;
      readonly refresh_token?: string;
      readonly expires_in?: number;
      readonly token_type?: string;
      readonly scope?: string;
    };

    if (typeof data.access_token !== "string") {
      return { ok: false, invalidClient: false };
    }

    return {
      ok: true,
      tokens: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt:
          typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
        tokenType: data.token_type,
        scope: data.scope,
      },
    };
  } catch {
    return { ok: false, invalidClient: false };
  }
}

/**
 * RFC 6749 §5.2 token-error responses always carry an `error` field. If
 * the body is unparseable or the field is absent, default to "not
 * invalid_client" so transient framing problems do not destroy the
 * persisted DCR client. invalid_client is the only value that
 * unambiguously signals the client identity has been rejected.
 */
async function isInvalidClientResponse(response: Response): Promise<boolean> {
  try {
    const body = (await response.clone().json()) as { readonly error?: unknown };
    return body.error === "invalid_client";
  } catch {
    return false;
  }
}
