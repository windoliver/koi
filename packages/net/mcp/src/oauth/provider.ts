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
  OAuthCallbackResult,
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

  async function getMetadata(): Promise<AuthServerMetadata | undefined> {
    if (cachedMetadata !== undefined) return cachedMetadata;
    cachedMetadata = await discoverAuthServer(serverUrl, oauthConfig);
    return cachedMetadata;
  }

  /**
   * Force a re-discovery, dropping any cached metadata first. Used
   * before classifying a session as terminal `dcr_unavailable` — the
   * cached document may have been a partial-rollout snapshot that
   * omitted `registration_endpoint`, and the AS could have recovered
   * since. Without this, a transient discovery degradation would
   * become a permanent terminal logout until process restart.
   */
  async function refreshMetadata(): Promise<AuthServerMetadata | undefined> {
    cachedMetadata = undefined;
    return getMetadata();
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
  /**
   * Per-attempt classification returned by `getClient`. Replaces the
   * earlier provider-global `lastDcrTerminal`/`lastDcrAttempted`
   * latches — concurrent flows mutated those without synchronization,
   * so one flow's reset could erase another flow's classification.
   * Carrying the verdict in a return value makes each attempt's state
   * lexically scoped and concurrency-safe.
   */
  type GetClientResult =
    | { readonly kind: "ok"; readonly client: OAuthClientInfo }
    | {
        readonly kind: "no_client";
        /** True when DCR was attempted (regardless of outcome). */
        readonly dcrAttempted: boolean;
        /** True when the DCR failure is non-retryable. */
        readonly dcrTerminal: boolean;
      };

  async function getClient(): Promise<GetClientResult> {
    if (oauthConfig.clientId !== undefined) {
      if (cachedClient === undefined) {
        cachedClient = { clientId: oauthConfig.clientId, registeredAt: 0, generation: "" };
      }
      return { kind: "ok", client: cachedClient };
    }

    // Phase 1: try the persisted client against the CACHED metadata
    // snapshot first — without forcing rediscovery. This protects
    // already-onboarded servers during a partial discovery outage:
    // if discovery temporarily lost `registration_endpoint` but the
    // stored client still validates against the cached issuer, we
    // can keep using it without paying for (and potentially failing
    // on) a rediscovery. The probe is unlocked because reads are
    // race-tolerant; the lock-protected write path below re-reads.
    const cachedMetadata = await getMetadata();
    const cachedAuthority = cachedMetadata?.issuer ?? oauthConfig.authServerMetadataUrl ?? "";
    if (cachedMetadata !== undefined) {
      const probe = await readClientInfo(
        storage,
        serverName,
        serverUrl,
        redirectUri,
        cachedAuthority,
      );
      if (probe !== undefined && isClientFresh(probe, cachedMetadata)) {
        cachedClient = probe;
        return { kind: "ok", client: probe };
      }
    }

    // Phase 2: stored-client miss (or stale). Force a rediscovery when
    // the cached snapshot lacks registration_endpoint — a degraded
    // partial-rollout snapshot may have lost it, and we need a fresh
    // metadata document before declaring DCR unavailable. The
    // entire withLock critical section below operates on the
    // post-refresh authority so reads/writes are consistent.
    let effectiveMetadata = cachedMetadata;
    if (effectiveMetadata?.registrationEndpoint === undefined) {
      effectiveMetadata = await refreshMetadata();
    }
    const authority = effectiveMetadata?.issuer ?? oauthConfig.authServerMetadataUrl ?? "";
    const lockKey = computeClientKey(serverName, serverUrl, redirectUri, authority);

    // Attempt-local DCR classification. Captured by the withLock
    // closure and mirrored into the returned GetClientResult below
    // — replaces the earlier provider-global latches that races
    // against concurrent flows could clobber.
    let lockedDcrAttempted = false;
    let lockedDcrTerminal = false;

    const resolved = await storage.withLock(lockKey, async () => {
      const stored = await readClientInfo(storage, serverName, serverUrl, redirectUri, authority);
      if (stored !== undefined && isClientFresh(stored, effectiveMetadata)) {
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
          if (legacy !== undefined && isClientFresh(legacy, effectiveMetadata)) {
            await storage.set(lockKey, JSON.stringify(legacy));
            await storage.delete(legacyKey);
            return legacy;
          }
        }
      }

      if (effectiveMetadata?.registrationEndpoint === undefined) return undefined;

      // registerDynamicClient throws on a non-HTTPS registration_endpoint
      // (it refuses to send registration credentials over cleartext).
      // Convert that into a fail-closed terminal so the rest of the
      // auth flow returns false instead of crashing through the provider.
      lockedDcrAttempted = true;
      let result: Awaited<ReturnType<typeof registerDynamicClient>>;
      try {
        result = await registerDynamicClient({
          registrationEndpoint: effectiveMetadata.registrationEndpoint,
          redirectUri,
          clientName: serverName,
          issuer: effectiveMetadata.issuer,
        });
      } catch (e: unknown) {
        // Throws are non-HTTPS endpoints — terminal until operator fixes.
        lockedDcrTerminal = true;
        reportFailure({
          kind: "dcr_failed",
          serverName,
          detail: e instanceof Error ? e.message : String(e),
        });
        return undefined;
      }
      if (!result.ok) {
        lockedDcrTerminal = result.terminal;
        reportFailure({ kind: "dcr_failed", serverName, detail: result.reason });
        return undefined;
      }

      // writeClientInfo would re-enter withLock on the same key — we
      // already own it, so persist directly to avoid a self-deadlock.
      await storage.set(lockKey, JSON.stringify(result.info));
      return result.info;
    });

    // Refresh the in-memory cache so onInvalidClient + post-revocation
    // checks see the current binding, but do NOT short-circuit the next
    // getClient call on it — see freshness rationale above.
    cachedClient = resolved;
    if (resolved !== undefined) {
      return { kind: "ok", client: resolved };
    }
    return {
      kind: "no_client",
      dcrAttempted: lockedDcrAttempted,
      dcrTerminal: lockedDcrTerminal,
    };
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
        let result: GetClientResult;
        try {
          result = await getClient();
        } catch {
          return { kind: "transient" };
        }
        if (result.kind === "ok") {
          return { kind: "ok", client: result.client };
        }
        // No client. Use the per-attempt classification carried in the
        // result instead of a shared latch — concurrent flows cannot
        // race over each other's DCR verdict.
        if (result.dcrTerminal) return { kind: "terminal" };
        // Even if DCR wasn't attempted (no registration_endpoint), a
        // truly-terminal classification needs a fresh discovery probe
        // first to avoid stranding sessions on a transient cache.
        if (!result.dcrAttempted) {
          const md = await getMetadata();
          if (md === undefined) return { kind: "transient" };
          if (oauthConfig.clientId === undefined && md.registrationEndpoint === undefined) {
            const fresh = await refreshMetadata();
            if (fresh?.registrationEndpoint !== undefined) return { kind: "transient" };
            return { kind: "terminal" };
          }
        }
        return { kind: "transient" };
      },
      // Forward refresh-time invalid_client signals to the DCR
      // invalidator. tokens.ts passes the EXACT OAuthClientInfo that
      // was sent on the failing request — clientId AND issuer — so
      // we can CAS-delete the right authority-scoped key even if
      // discovery has flipped between the failure and this callback.
      // Static configured clients (registeredAt === 0) are never
      // silently deleted.
      onInvalidClient: async (failingClient: OAuthClientInfo) => {
        if (failingClient.registeredAt > 0) {
          await invalidateRegisteredClient(failingClient);
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
   *
   * CAS-gated on the `expectedClientId` that actually failed: a stale
   * flow that started before another process repaired the shared record
   * MUST NOT erase the newer valid registration. If the persisted
   * clientId no longer matches what we used, only the in-memory cache
   * is dropped — the next getClient call will pick up the fresh record.
   *
   * The authority used to derive the storage key MUST be the one the
   * failing client_id was registered under, NOT a fresh recomputation
   * from current metadata. Discovery may have flipped issuers between
   * the failed token request and this cleanup; recomputing here would
   * delete the wrong key and leave the revoked client persisted under
   * the original authority forever. Persisted records carry their
   * `issuer` so we can reconstruct the original key exactly.
   */
  const invalidateRegisteredClient = async (expectedClient: OAuthClientInfo): Promise<void> => {
    cachedClient = undefined;
    tokenManager = undefined;
    const authority = expectedClient.issuer ?? oauthConfig.authServerMetadataUrl ?? "";
    const lockKey = computeClientKey(serverName, serverUrl, redirectUri, authority);
    await storage.withLock(lockKey, async () => {
      const current = await readClientInfo(storage, serverName, serverUrl, redirectUri, authority);
      // CAS on the opaque per-registration `generation` token.
      // clientId alone is unsafe (some ASes deterministically reissue
      // the same client_id) and registeredAt alone is non-unique
      // under fast retries (Date.now() can collide in the same
      // millisecond). The generation is a random UUID issued at
      // registration time — collision probability is effectively
      // zero, so a stale invalidation cannot match a fresher record.
      //
      // Empty/undefined generation is the legacy shape (records
      // persisted before this field existed, or static clients) —
      // never CAS-delete those. Operators clear them via storage
      // surgery / a future `koi mcp reset-client` subcommand.
      if (
        current !== undefined &&
        current.generation !== undefined &&
        current.generation !== "" &&
        current.generation === expectedClient.generation
      ) {
        await storage.delete(lockKey);
      }
    });
  };

  // --- Interactive auth flow ---
  const startAuthFlow = async (): Promise<boolean> => {
    let metadata = await getMetadata();
    if (metadata === undefined) {
      reportFailure({ kind: "discovery_failed", serverName });
      return false;
    }

    const clientResult = await getClient();
    if (clientResult.kind !== "ok") {
      // Suppress `dcr_unavailable` when getClient already attempted DCR
      // and emitted a more specific `dcr_failed` reason. The
      // attempt-local `dcrAttempted` flag carries the verdict for
      // exactly this attempt — no shared latches that concurrent
      // flows could clobber.
      //
      // Re-read metadata so the registration_endpoint check reflects
      // the post-recovery snapshot, not a stale pre-refresh one.
      if (!clientResult.dcrAttempted && oauthConfig.clientId === undefined) {
        const post = await getMetadata();
        if (post?.registrationEndpoint === undefined) {
          reportFailure({ kind: "dcr_unavailable", serverName });
        }
      }
      return false;
    }
    const client = clientResult.client;

    // getClient() may have re-discovered metadata (degraded snapshot
    // recovery) and registered the client against the refreshed
    // authorization server. Re-read the cached metadata so the
    // authorize/token endpoints we hit BELONG TO THE SAME ISSUER as
    // the client_id. Without this, a freshly registered DCR client
    // could be sent to stale authorize/token endpoints from the
    // earlier degraded discovery.
    const postClientMetadata = await getMetadata();
    if (postClientMetadata !== undefined) {
      metadata = postClientMetadata;
    }

    const pkce = createPkceChallenge();

    // Build authorization URL with `resource` (when enabled). If the
    // authorization endpoint itself rejects RFC 8707 (legacy AS that
    // rejects the unknown query parameter before redirecting back), the
    // runtime.authorize promise typically rejects with a browser
    // error. We retry once with `resource` stripped — mirrors the
    // token-exchange shim so legacy ASes don't hard-fail every login.
    const buildAuthUrl = (state: string, includeResource: boolean): URL => {
      const url = new URL(metadata.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("code_challenge", pkce.challenge);
      url.searchParams.set("code_challenge_method", pkce.method);
      if (includeResource && resourceIndicator !== undefined) {
        url.searchParams.set("resource", resourceIndicator);
      }
      url.searchParams.set("state", state);
      return url;
    };

    // Generate a random state parameter for CSRF protection
    const state = crypto.randomUUID();

    // runtime.authorize is host-implemented (browser launch + local
    // callback listener) and can fail for many reasons unrelated to
    // OAuth: browser launch error, callback timeout, user-cancelled
    // auth, listener bind error. startAuthFlow's contract is
    // Promise<boolean> — never throw. Catch ALL failures, report a
    // structured signal, and fall through to the closed-fail return
    // below.
    let callbackResult: OAuthCallbackResult | undefined;
    let lastAuthorizeError: unknown;
    try {
      callbackResult = await runtime.authorize(buildAuthUrl(state, true).toString(), redirectUri);
    } catch (firstErr: unknown) {
      lastAuthorizeError = firstErr;
      // RFC 8707 compatibility: a legacy AS that rejects the unknown
      // `resource` query at the authorization endpoint surfaces here.
      // Retry once without `resource` only when we actually sent it.
      if (resourceIndicator !== undefined) {
        try {
          callbackResult = await runtime.authorize(
            buildAuthUrl(state, false).toString(),
            redirectUri,
          );
          lastAuthorizeError = undefined;
        } catch (secondErr: unknown) {
          // Fall through; callbackResult stays undefined and we fail closed.
          // Keep the FIRST error as the diagnostic (it's the one operators
          // would see in their browser), but record the second too.
          void secondErr;
        }
      }
    }
    if (callbackResult === undefined) {
      // Distinct from discovery_failed: local browser/callback failure
      // (launch error, listener bind, timeout, user-cancel) — not an
      // AS-side problem. Hosts route remediation differently for each.
      //
      // We do NOT invalidate the persisted DCR client here: a local
      // launch/timeout/cancel failure is not evidence that the
      // client_id is stale, and auto-deleting on every local failure
      // would leak orphaned registrations on every browser hiccup.
      // A genuinely stale DCR client will either surface as
      // `invalid_client` at token exchange (handled via CAS) or
      // require explicit operator action — `koi mcp logout` followed
      // by a fresh `koi mcp auth` re-triggers DCR cleanly.
      reportFailure({
        kind: "authorize_failed",
        serverName,
        detail:
          lastAuthorizeError instanceof Error
            ? lastAuthorizeError.message
            : String(lastAuthorizeError ?? "runtime.authorize failed"),
      });
      return false;
    }

    // Validate state parameter to prevent CSRF attacks
    if (callbackResult.state !== state) {
      reportFailure({ kind: "state_mismatch", serverName });
      return false;
    }

    // Exchange authorization code for tokens
    let exchange = await exchangeCode(
      callbackResult.code,
      pkce.verifier,
      redirectUri,
      metadata.tokenEndpoint,
      client.clientId,
      resourceIndicator,
    );

    // RFC 8707 compatibility shim mirrored from the refresh path: if we
    // sent `resource` and the AS rejected it (`invalid_target` /
    // `invalid_request`), retry the exchange once without `resource`
    // before failing closed. Without this, fresh auth against a legacy
    // AS hard-fails on every login even though the same server may have
    // worked before this branch added the default `resource`.
    if (!exchange.ok && exchange.resourceRejected && resourceIndicator !== undefined) {
      exchange = await exchangeCode(
        callbackResult.code,
        pkce.verifier,
        redirectUri,
        metadata.tokenEndpoint,
        client.clientId,
        undefined,
      );
    }

    if (!exchange.ok) {
      // Only invalidate the persisted DCR client on an explicit
      // `invalid_client` signal — transient 5xx, timeouts, malformed
      // responses, or non-client errors must not destroy a healthy
      // registration. CAS on the failing clientId so a stale flow
      // cannot wipe a newer registration another process already wrote.
      if (exchange.invalidClient && client.registeredAt > 0) {
        await invalidateRegisteredClient(client);
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
 * `resourceRejected` lets the caller retry once without RFC 8707
 * `resource` against a legacy AS, mirroring the refresh-path shim.
 */
type ExchangeResult =
  | { readonly ok: true; readonly tokens: OAuthTokens }
  | {
      readonly ok: false;
      readonly invalidClient: boolean;
      readonly resourceRejected: boolean;
    };

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
      const errorCode = await readExchangeErrorCode(response);
      return {
        ok: false,
        invalidClient: errorCode === "invalid_client",
        // RFC 8707 §2: an AS that does not recognize the `resource`
        // parameter returns `invalid_target`. `invalid_request` is
        // RFC 6749's general catch-all (PKCE mismatch, malformed
        // redirect, duplicated params) and MUST NOT trigger an
        // automatic retry — replaying the auth code here would
        // consume a single-use code and mask the real error.
        resourceRejected: errorCode === "invalid_target",
      };
    }

    const data = (await response.json()) as {
      readonly access_token?: string;
      readonly refresh_token?: string;
      readonly expires_in?: number;
      readonly token_type?: string;
      readonly scope?: string;
    };

    if (typeof data.access_token !== "string") {
      return { ok: false, invalidClient: false, resourceRejected: false };
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
    return { ok: false, invalidClient: false, resourceRejected: false };
  }
}

/**
 * Read RFC 6749 §5.2 token-error `error` field. Returns undefined when
 * the body is unparseable or the field is absent so transient framing
 * problems do not get misclassified as client revocation or resource
 * rejection.
 */
async function readExchangeErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as { readonly error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}
