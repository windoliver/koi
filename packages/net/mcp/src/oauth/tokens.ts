/**
 * Token manager — handles OAuth token persistence and refresh.
 *
 * Uses SecureStorage for persistence with file-locking for concurrent
 * access safety. Tokens are stored as JSON keyed by server identity.
 */

import { createHash } from "node:crypto";
import type { SecureStorage } from "@koi/secure-storage";
import type { AuthServerMetadata, OAuthClientInfo, OAuthTokens } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenManager {
  /** Get the current access token, refreshing if expired. */
  readonly getAccessToken: () => Promise<string | undefined>;
  /** Store a new token set. */
  readonly storeTokens: (tokens: OAuthTokens) => Promise<void>;
  /** Clear all stored tokens for this server. */
  readonly clearTokens: () => Promise<boolean>;
  /** Check if tokens exist (without refreshing). */
  readonly hasTokens: () => Promise<boolean>;
}

export interface TokenManagerOptions {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly storage: SecureStorage;
  readonly metadata?: AuthServerMetadata | undefined;
  /**
   * Eager client_id, when known up-front (configured static client). Mutually
   * exclusive with `getClientId` — `getClientId` is preferred for DCR flows
   * because it lets the token manager resolve (and trigger registration)
   * lazily, only when a refresh actually needs a client.
   */
  readonly clientId?: string | undefined;
  /**
   * Lazy client_id resolver. Invoked exclusively from the refresh path so
   * that a passive `getAccessToken()` call with no stored tokens never
   * triggers DCR. A plain `token()` probe must be side-effect free —
   * otherwise reconnect retries can leak orphaned OAuth client
   * registrations on the authorization server.
   */
  readonly getClientId?: (() => Promise<string | undefined>) | undefined;
  /**
   * RFC 8707 resource indicator. Pass-through (no fallback to serverUrl):
   * the refresh body MUST mirror the initial-auth choice exactly.
   */
  readonly resource?: string | undefined;
  /**
   * Fired when the refresh endpoint responds with `error: "invalid_client"`.
   * The provider uses this to drop a revoked DCR client_id before the
   * next interactive auth attempt — without it, the first re-auth would
   * reuse the dead client and fail again before the registration was
   * finally cleared in the code-exchange path.
   */
  readonly onInvalidClient?: (() => Promise<void> | void) | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Refresh token 60 seconds before actual expiry to avoid race conditions. */
const EXPIRY_BUFFER_MS = 60_000;
const REFRESH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTokenManager(options: TokenManagerOptions): TokenManager {
  const { serverName, serverUrl, storage, metadata, clientId, getClientId, onInvalidClient } =
    options;
  // Lazy resolver fallback: when the caller provides a static `clientId`,
  // wrap it in a getter so the refresh path is uniform. Both branches
  // ultimately produce a `string | undefined` only inside refresh —
  // never during the initial getTokens() probe.
  const resolveClientId = async (): Promise<string | undefined> => {
    if (getClientId !== undefined) return getClientId();
    return clientId;
  };
  // RFC 8707 resource indicator. Pass-through (no fallback to serverUrl):
  // callers — provider in particular — set `resource` to the effective
  // value chosen for initial authorization. The refresh body MUST mirror
  // that decision exactly, otherwise an `includeResourceParameter: false`
  // server would accept the initial token and reject the refresh.
  const resource = options.resource;
  const storageKey = computeServerKey(serverName, serverUrl);

  const getTokens = async (): Promise<OAuthTokens | undefined> => {
    const raw = await storage.get(storageKey);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as OAuthTokens;
    } catch {
      return undefined;
    }
  };

  const storeTokens = async (tokens: OAuthTokens): Promise<void> => {
    await storage.withLock(storageKey, async () => {
      await storage.set(storageKey, JSON.stringify(tokens));
    });
  };

  const clearTokens = async (): Promise<boolean> => {
    return storage.withLock(storageKey, async () => {
      return storage.delete(storageKey);
    });
  };

  const hasTokens = async (): Promise<boolean> => {
    const raw = await storage.get(storageKey);
    return raw !== undefined;
  };

  const getAccessToken = async (): Promise<string | undefined> => {
    // Read tokens under lock (fast — no network)
    const tokens = await storage.withLock(storageKey, () => getTokens());
    if (tokens === undefined) return undefined;

    // Check if access token is still valid (no lock needed)
    if (!isExpired(tokens)) {
      return tokens.accessToken;
    }

    // Try to refresh — outside the lock to avoid blocking concurrent readers
    // during the 15s network call
    if (tokens.refreshToken === undefined || metadata === undefined) {
      await storage.withLock(storageKey, () => storage.delete(storageKey));
      return undefined;
    }

    // Capture the refresh token we used — needed for compare-and-swap below
    const usedRefreshToken = tokens.refreshToken;

    // Resolve clientId LAZILY here — never during the no-tokens probe
    // above. For DCR-backed configs this triggers registration only
    // when there is something to refresh.
    let refreshClientId: string | undefined;
    try {
      refreshClientId = await resolveClientId();
    } catch {
      refreshClientId = undefined;
    }

    // For DCR-backed configs (caller supplied a `getClientId` resolver),
    // a missing client_id means the resolver failed transiently —
    // network blip during discovery, registration timeout, etc. Sending
    // a refresh without client_id would get classified as terminal 4xx
    // and wipe a perfectly good refresh token. Return undefined (no
    // current valid token) WITHOUT clearing stored state, so the next
    // getAccessToken() attempt can re-resolve. Static-clientId callers
    // fall through (their absence is operator intent, not transient).
    if (refreshClientId === undefined && getClientId !== undefined) {
      return undefined;
    }

    let refreshResult = await refreshAccessToken(
      usedRefreshToken,
      metadata.tokenEndpoint,
      refreshClientId,
      resource,
    );

    // RFC 8707 compatibility shim: if we sent `resource` and the AS
    // rejected it (`invalid_target` / `invalid_request`), retry once
    // without `resource` before classifying the failure as terminal.
    // Without this, a legacy authorization server upgrade silently logs
    // operators out on the first refresh because the default sends
    // `resource` and any 4xx is treated as a revoked token.
    if (
      !refreshResult.ok &&
      refreshResult.terminal &&
      refreshResult.resourceRejected &&
      resource !== undefined
    ) {
      refreshResult = await refreshAccessToken(
        usedRefreshToken,
        metadata.tokenEndpoint,
        refreshClientId,
        undefined,
      );
    }

    // Surface invalid_client to the provider so it can drop the persisted
    // DCR client BEFORE the next interactive auth — without this, the
    // first re-auth would reuse the dead client_id and fail again before
    // the registration was finally cleared in the code-exchange path.
    if (!refreshResult.ok && refreshResult.invalidClient && onInvalidClient !== undefined) {
      try {
        await onInvalidClient();
      } catch {
        // Callback failures must not mask the underlying refresh error.
      }
    }

    // Compare-and-swap: under lock, check that the on-disk refresh token
    // still matches what we used. If another process already refreshed and
    // rotated the token, our result (or deletion) is stale — skip it.
    return storage.withLock(storageKey, async () => {
      const current = await getTokens();

      if (!refreshResult.ok) {
        if (refreshResult.terminal && current?.refreshToken === usedRefreshToken) {
          // Only clear if no one else has refreshed since we started
          await storage.delete(storageKey);
        }
        // If another process already refreshed, return their access token
        if (current !== undefined && !isExpired(current)) {
          return current.accessToken;
        }
        return undefined;
      }

      // Another process may have already written a newer token set
      if (current?.refreshToken !== undefined && current.refreshToken !== usedRefreshToken) {
        // Someone else already refreshed — use theirs if valid
        if (!isExpired(current)) return current.accessToken;
      }

      // Write our refreshed tokens
      await storage.set(storageKey, JSON.stringify(refreshResult.tokens));
      return refreshResult.tokens.accessToken;
    });
  };

  return { getAccessToken, storeTokens, clearTokens, hasTokens };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a stable storage key from server name + URL.
 * Format: `mcp-oauth|{name}|{sha256(url)[:16]}`
 */
export function computeServerKey(serverName: string, serverUrl: string): string {
  const hash = createHash("sha256").update(serverUrl).digest("hex").substring(0, 16);
  return `mcp-oauth|${serverName}|${hash}`;
}

/**
 * Storage key for dynamically-registered client info. Keyed by the full
 * DCR identity contract — `serverUrl` + `redirectUri` + `authority` — so:
 *
 *   1. Alias renames with identical URL + callback port + authority
 *      reuse the same registered client (no orphan churn on the AS).
 *   2. Two configs with the same URL but different callback ports get
 *      distinct records (the redirect_uri contract differs).
 *   3. Two configs with the same URL + port but different OAuth
 *      authorities (different `authServerMetadataUrl` / discovered
 *      issuer) get distinct records — one tenant's auth state cannot
 *      clobber another's.
 *
 * `authority` is the discovered issuer when known, falling back to the
 * configured `authServerMetadataUrl`, falling back to empty (no
 * discriminator) when neither is available. The `serverName` parameter
 * is retained for symmetry with `computeServerKey()` but ignored.
 *
 * Format: `mcp-oauth-client|{sha256(serverUrl + "|" + redirectUri + "|" + authority)[:16]}`.
 */
export function computeClientKey(
  _serverName: string,
  serverUrl: string,
  redirectUri: string,
  authority: string = "",
): string {
  const hash = createHash("sha256")
    .update(`${serverUrl}|${redirectUri}|${authority}`)
    .digest("hex")
    .substring(0, 16);
  return `mcp-oauth-client|${hash}`;
}

/** Read persisted `OAuthClientInfo` for a (server, redirect, authority) triple; undefined when absent or corrupt. */
export async function readClientInfo(
  storage: SecureStorage,
  serverName: string,
  serverUrl: string,
  redirectUri: string,
  authority: string = "",
): Promise<OAuthClientInfo | undefined> {
  const raw = await storage.get(computeClientKey(serverName, serverUrl, redirectUri, authority));
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as OAuthClientInfo;
  } catch {
    return undefined;
  }
}

/**
 * Persist `OAuthClientInfo` under the (server, redirect, authority)
 * client-info storage key. `authority` is optional (defaults to "") so
 * existing callers without tenant scoping keep working — provider
 * always passes the discovered issuer / configured authServerMetadataUrl.
 */
export async function writeClientInfo(
  storage: SecureStorage,
  serverName: string,
  serverUrl: string,
  redirectUri: string,
  info: OAuthClientInfo,
  authority: string = "",
): Promise<void> {
  const key = computeClientKey(serverName, serverUrl, redirectUri, authority);
  await storage.withLock(key, async () => {
    await storage.set(key, JSON.stringify(info));
  });
}

function isExpired(tokens: OAuthTokens): boolean {
  if (tokens.expiresAt === undefined) return false;
  return Date.now() >= tokens.expiresAt - EXPIRY_BUFFER_MS;
}

/**
 * Terminal: token is invalid, must re-auth. Transient: temporary failure,
 * keep tokens. `invalidClient` is set when the AS specifically returned
 * `error: "invalid_client"`, distinguishing client-revocation from
 * `invalid_grant` and other terminal failures so the provider can drop
 * the persisted DCR client_id before the next interactive auth.
 * `resourceRejected` is set on `invalid_target` / `invalid_request` so
 * the caller can retry without RFC 8707 `resource` against legacy AS.
 */
type RefreshResult =
  | { readonly ok: true; readonly tokens: OAuthTokens }
  | {
      readonly ok: false;
      readonly terminal: boolean;
      readonly invalidClient: boolean;
      readonly resourceRejected: boolean;
    };

async function refreshAccessToken(
  refreshToken: string,
  tokenEndpoint: string,
  clientId: string | undefined,
  resource: string | undefined,
): Promise<RefreshResult> {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (clientId !== undefined) {
      body.set("client_id", clientId);
    }
    if (resource !== undefined) {
      body.set("resource", resource);
    }

    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });

    if (!response.ok) {
      // 400/401 = terminal (invalid_grant, revoked token). 5xx = transient.
      // RFC 6749 §5.2 token-error responses always carry an `error` field;
      // parse it once so we can surface invalid_client + resource-related
      // rejections distinctly without losing terminal/transient
      // classification.
      const terminal = response.status < 500;
      const errorCode = terminal ? await readErrorCode(response) : undefined;
      return {
        ok: false,
        terminal,
        invalidClient: errorCode === "invalid_client",
        resourceRejected: errorCode === "invalid_target" || errorCode === "invalid_request",
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
      return { ok: false, terminal: true, invalidClient: false, resourceRejected: false };
    }

    return {
      ok: true,
      tokens: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? refreshToken,
        expiresAt:
          typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
        tokenType: data.token_type,
        scope: data.scope,
      },
    };
  } catch {
    // Network error, timeout — transient, preserve tokens
    return { ok: false, terminal: false, invalidClient: false, resourceRejected: false };
  }
}

/**
 * Read RFC 6749 §5.2 token-error `error` field. Returns undefined for
 * unparseable bodies or missing fields so transient framing problems
 * never get misclassified as client revocation or resource rejection.
 */
async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as { readonly error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}
