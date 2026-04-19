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
  OAuthFailureReason,
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

  /**
   * Best-effort fan-out to the host's structured-failure observer.
   * Swallows all errors — observer failures cannot affect the underlying
   * auth flow we are already failing closed on.
   */
  const reportFailure = (reason: OAuthFailureReason): void => {
    if (runtime.onAuthFailure === undefined) return;
    try {
      runtime.onAuthFailure(reason);
    } catch {
      // Observer must not break auth flow.
    }
  };

  // Mutable state — justified: caches metadata + resolved client across token() calls
  let cachedMetadata: AuthServerMetadata | undefined;
  let cachedClient: OAuthClientInfo | undefined;
  let tokenManager: TokenManager | undefined;
  // Sticky terminal flag — set when getClient sees a non-retryable DCR
  // failure (insecure registration_endpoint, confidential client,
  // narrowed redirect_uris, etc.). The refresh path consults this so
  // it can clear stored tokens and surface onReauthNeeded instead of
  // looping forever on transient classification.
  let lastDcrTerminal = false;

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
    // Discriminate persisted DCR records by OAuth authority so two
    // configs with the same MCP URL + port but different
    // `authServerMetadataUrl` (or different discovered issuer) get
    // independent client records. Without this, one tenant's
    // re-registration could clobber another's, or a stale clientId
    // from one issuer could be sent to a different one.
    const authority = metadata?.issuer ?? oauthConfig.authServerMetadataUrl ?? "";
    const lockKey = computeClientKey(serverName, serverUrl, redirectUri, authority);

    const resolved = await storage.withLock(lockKey, async () => {
      const stored = await readClientInfo(storage, serverName, serverUrl, redirectUri, authority);
      if (stored !== undefined && isClientFresh(stored, metadata)) {
        return stored;
      }

      // Migration probe: before triggering a fresh DCR, look for a
      // record under the prior key shape (no authority). When found
      // and still fresh against current metadata, promote it to the
      // new authority-scoped key so an upgrade does not re-register
      // (and orphan) every previously persisted client. The legacy
      // record is deleted only after the new write succeeds so a
      // crash leaves at least one copy intact.
      if (stored === undefined && authority !== "") {
        const legacyKey = computeClientKey(serverName, serverUrl, redirectUri, "");
        if (legacyKey !== lockKey) {
          const legacy = await readClientInfo(storage, serverName, serverUrl, redirectUri, "");
          if (legacy !== undefined && isClientFresh(legacy, metadata)) {
            await storage.set(lockKey, JSON.stringify(legacy));
            await storage.delete(legacyKey);
            return legacy;
          }
        }
      }

      if (metadata?.registrationEndpoint === undefined) return undefined;

      // registerDynamicClient throws on a non-HTTPS registration_endpoint
      // (it refuses to send registration credentials over cleartext).
      // Convert that into a fail-closed terminal so the rest of the
      // auth flow returns false instead of crashing through the provider.
      let result: Awaited<ReturnType<typeof registerDynamicClient>>;
      try {
        result = await registerDynamicClient({
          registrationEndpoint: metadata.registrationEndpoint,
          redirectUri,
          clientName: serverName,
          issuer: metadata.issuer,
        });
      } catch (e: unknown) {
        // Throws are non-HTTPS endpoints — terminal until operator fixes.
        lastDcrTerminal = true;
        reportFailure({
          kind: "dcr_failed",
          serverName,
          detail: e instanceof Error ? e.message : String(e),
        });
        return undefined;
      }
      if (!result.ok) {
        lastDcrTerminal = result.terminal;
        reportFailure({ kind: "dcr_failed", serverName, detail: result.reason });
        return undefined;
      }
      lastDcrTerminal = false;

      // writeClientInfo would re-enter withLock on the same key — we
      // already own it, so persist directly to avoid a self-deadlock.
      await storage.set(lockKey, JSON.stringify(result.info));
      return result.info;
    });

    // Refresh the in-memory cache so onInvalidClient + post-revocation
    // checks see the current binding, but do NOT short-circuit the next
    // getClient call on it — see freshness rationale above.
    cachedClient = resolved;
    return resolved;
  }

  async function getTokenManager(): Promise<TokenManager> {
    if (tokenManager !== undefined) return tokenManager;
    // Pass `getMetadata` (lazy) instead of the snapshot. A provider
    // built while discovery was briefly down would otherwise capture
    // metadata: undefined into the cached manager and skip every
    // refresh forever, even after discovery recovered.
    tokenManager = createTokenManager({
      serverName,
      serverUrl,
      storage,
      getMetadata,
      resource: resourceIndicator,
      // Lazy: a passive `token()` call with no stored tokens must NOT
      // trigger DCR. Resolution fires only inside the refresh path,
      // when there is actually a token set worth rotating. The result
      // distinguishes ok / transient / terminal so tokens.ts can clear
      // a permanently unresolvable session instead of preserving dead
      // state forever.
      getClientId: async () => {
        try {
          const client = await getClient();
          if (client !== undefined) return { kind: "ok", clientId: client.clientId };
        } catch {
          return { kind: "transient" };
        }
        // Client could not be resolved. Distinguish:
        //   - Discovery itself failed (metadata undefined): TRANSIENT.
        //     A brief outage at process start cannot prove DCR is
        //     permanently gone — wiping tokens here would force-logout
        //     a recoverable session.
        //   - Discovery succeeded BUT no registration_endpoint AND no
        //     static clientId: TERMINAL — there is no operator-free
        //     recovery path.
        //   - DCR was attempted and returned a terminal failure
        //     (insecure endpoint, confidential, narrowed redirect_uris):
        //     TERMINAL — operator must fix config or AS state.
        //   - Otherwise (transient registration failure): preserve
        //     tokens for the next attempt to retry.
        const md = await getMetadata();
        if (md === undefined) return { kind: "transient" };
        if (oauthConfig.clientId === undefined && md.registrationEndpoint === undefined) {
          return { kind: "terminal" };
        }
        if (lastDcrTerminal) {
          return { kind: "terminal" };
        }
        return { kind: "transient" };
      },
      // Forward refresh-time invalid_client signals to the DCR
      // invalidator. tokens.ts passes the EXACT clientId that failed,
      // not whatever cachedClient currently holds, so a concurrent
      // re-registration cannot trick this path into deleting a fresh
      // record. We still gate on registeredAt > 0 so static configured
      // clients are never silently deleted.
      onInvalidClient: async (failingClientId: string) => {
        if (cachedClient !== undefined && cachedClient.registeredAt > 0) {
          await invalidateRegisteredClient(failingClientId);
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
    const metadata = await getMetadata();
    const authority = metadata?.issuer ?? oauthConfig.authServerMetadataUrl ?? "";
    const lockKey = computeClientKey(serverName, serverUrl, redirectUri, authority);
    await storage.withLock(lockKey, async () => {
      const current = await readClientInfo(storage, serverName, serverUrl, redirectUri, authority);
      if (current !== undefined && current.clientId === expectedClientId) {
        await storage.delete(lockKey);
      }
    });
  };

  // --- Interactive auth flow ---
  const startAuthFlow = async (): Promise<boolean> => {
    const metadata = await getMetadata();
    if (metadata === undefined) {
      reportFailure({ kind: "discovery_failed", serverName });
      return false;
    }

    const client = await getClient();
    if (client === undefined) {
      // No configured clientId AND no usable registration_endpoint to
      // DCR against — nothing we can do without operator intervention.
      // The dcr_failed report (when applicable) was already fired
      // inside getClient; emit dcr_unavailable when the AS simply
      // doesn't advertise registration.
      if (oauthConfig.clientId === undefined && metadata.registrationEndpoint === undefined) {
        reportFailure({ kind: "dcr_unavailable", serverName });
      }
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
      reportFailure({ kind: "state_mismatch", serverName });
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
      reportFailure({
        kind: "exchange_failed",
        serverName,
        invalidClient: exchange.invalidClient,
      });
      return false;
    }

    // Store tokens
    const tm = await getTokenManager();
    await tm.storeTokens(exchange.tokens);
    return true;
  };

  // --- 401 handling ---
  // On 401: try refreshing first (access token may have expired normally).
  // Only clear tokens / prompt re-auth on a TERMINAL refresh failure.
  // Transient failures (network blip, DCR resolver miss, 5xx) leave the
  // refresh token in place via tokens.ts; we detect that by re-checking
  // hasTokens() and skipping the destructive path so a temporary outage
  // can't force-logout an otherwise-healthy session.
  const handleUnauthorized = async (): Promise<void> => {
    const tm = await getTokenManager();
    const refreshed = await tm.getAccessToken();
    if (refreshed !== undefined) {
      // Refresh succeeded — the next reconnect will pick up the new token.
      return;
    }
    // refreshed === undefined could mean either:
    //   (a) terminal refresh failure → tokens.ts already cleared storage
    //   (b) transient failure → tokens.ts deliberately preserved tokens
    // Distinguish by inspecting storage. Only call clearTokens +
    // onReauthNeeded in the (a) case so transient outages do not
    // permanently delete a still-valid refresh token.
    if (await tm.hasTokens()) {
      return;
    }
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
 * Issuer is the load-bearing check — DCR client_ids are issuer-scoped
 * so any change there means the stored id no longer belongs to the
 * authorization server we are about to talk to.
 *
 * `registration_endpoint` is checked only when current metadata
 * advertises one. An AS that has disabled DCR (or whose discovery
 * temporarily omits the endpoint) does NOT invalidate already-issued
 * client_ids — they keep working at the authorize/token endpoints.
 * Without this carve-out, a transient discovery degradation would
 * brick every previously-registered client.
 *
 * DCR records (`registeredAt > 0`) MUST still carry the issuer
 * binding — anything else is legacy/unbound persistence and a stale
 * id reuse hazard, so treat it as stale and re-register cleanly.
 * Static records (`registeredAt === 0`) bypass all checks; their
 * `clientId` is operator-managed.
 */
function isClientFresh(stored: OAuthClientInfo, metadata: AuthServerMetadata | undefined): boolean {
  if (stored.registeredAt === 0) return true;
  if (metadata === undefined) return false;
  if (stored.issuer === undefined || stored.issuer !== metadata.issuer) return false;
  if (
    metadata.registrationEndpoint !== undefined &&
    stored.registrationEndpoint !== undefined &&
    stored.registrationEndpoint !== metadata.registrationEndpoint
  ) {
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
