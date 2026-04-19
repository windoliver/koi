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
  /**
   * Eager metadata snapshot. Mutually exclusive with `getMetadata` —
   * `getMetadata` is preferred for long-lived providers because it
   * lets refresh re-discover after a transient outage at construction
   * time without rebuilding the manager.
   */
  readonly metadata?: AuthServerMetadata | undefined;
  /**
   * Lazy metadata resolver. Invoked per-refresh attempt so a provider
   * created while discovery was briefly unavailable can recover once
   * discovery starts succeeding — without this, a manager built with
   * `metadata: undefined` would skip every refresh forever even after
   * the AS came back online.
   */
  readonly getMetadata?: (() => Promise<AuthServerMetadata | undefined>) | undefined;
  /**
   * Eager client_id, when known up-front (configured static client). Mutually
   * exclusive with `getClientId` — `getClientId` is preferred for DCR flows
   * because it lets the token manager resolve (and trigger registration)
   * lazily, only when a refresh actually needs a client.
   */
  readonly clientId?: string | undefined;
  /**
   * Lazy client resolver. Invoked exclusively from the refresh path so
   * that a passive `getAccessToken()` call with no stored tokens never
   * triggers DCR. A plain `token()` probe must be side-effect free —
   * otherwise reconnect retries can leak orphaned OAuth client
   * registrations on the authorization server.
   *
   * The result is a discriminated union so the refresh path can tell
   * `transient` (network blip, registration timeout — preserve tokens
   * for the next attempt) from `terminal` (no static clientId AND no
   * usable registration_endpoint — there is no path to ever recover
   * a client without operator intervention; clear tokens so
   * `handleUnauthorized` can trigger re-auth instead of leaving the
   * session permanently stuck with undeletable expired credentials).
   *
   * The `client` payload carries the full `OAuthClientInfo` so the
   * refresh path can pass it through to `onInvalidClient` unchanged —
   * letting the provider invalidate against the exact authority the
   * failing client was registered under, even if discovery has
   * flipped to a different issuer in the meantime.
   */
  readonly getClientId?:
    | (() => Promise<
        | { readonly kind: "ok"; readonly client: OAuthClientInfo }
        | { readonly kind: "transient" }
        | { readonly kind: "terminal" }
      >)
    | undefined;
  /**
   * RFC 8707 resource indicator. Pass-through (no fallback to serverUrl):
   * the refresh body MUST mirror the initial-auth choice exactly.
   */
  readonly resource?: string | undefined;
  /**
   * Fired when the refresh endpoint responds with `error: "invalid_client"`.
   * Receives the FULL OAuthClientInfo that was sent on the failing
   * request — clientId AND issuer — so the provider can CAS-delete
   * the exact stored record under the exact authority the client
   * was registered with. Reading a mutable provider cache here, or
   * recomputing the authority from current metadata, would race with
   * concurrent flows that may have flipped issuers between the
   * failing request and this callback.
   */
  readonly onInvalidClient?: ((client: OAuthClientInfo) => Promise<void> | void) | undefined;
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
  // Resolve metadata fresh on each refresh so a manager built while
  // discovery was briefly down can recover. Falls back to the
  // construction-time snapshot when no resolver was supplied.
  const resolveMetadata = async (): Promise<AuthServerMetadata | undefined> => {
    if (options.getMetadata !== undefined) return options.getMetadata();
    return metadata;
  };
  // Lazy resolver fallback: static `clientId` is treated as always-ok.
  // Returns the same discriminated union as the DCR path so the refresh
  // flow has one branching point for transient/terminal/ok. Static
  // clients have no DCR-issued issuer; we synthesize a record with
  // registeredAt: 0 so onInvalidClient can detect it as static (and
  // skip persistent-storage cleanup). Empty clientId means no client
  // header at all — some ASes accept refresh without client_id.
  type ClientResolution =
    | { readonly kind: "ok"; readonly client: OAuthClientInfo }
    | { readonly kind: "transient" }
    | { readonly kind: "terminal" };
  const resolveClientId = async (): Promise<ClientResolution> => {
    if (getClientId !== undefined) return getClientId();
    if (clientId !== undefined) {
      return { kind: "ok", client: { clientId, registeredAt: 0 } };
    }
    return { kind: "ok", client: { clientId: "", registeredAt: 0 } };
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
    // Read tokens under lock (fast — no network). When the stored
    // record is corrupt — raw key exists but JSON parse fails —
    // delete it. handleUnauthorized uses hasTokens() as the
    // transient/terminal discriminator; leaving a poisoned record in
    // place would make it think the session is still recoverable
    // and suppress onReauthNeeded forever.
    const tokens = await storage.withLock(storageKey, async () => {
      const parsed = await getTokens();
      if (parsed === undefined) {
        const raw = await storage.get(storageKey);
        if (raw !== undefined) {
          // Raw exists but couldn't parse → corrupt. Drop it.
          await storage.delete(storageKey);
        }
      }
      return parsed;
    });
    if (tokens === undefined) return undefined;

    // Check if access token is still valid (no lock needed)
    if (!isExpired(tokens)) {
      return tokens.accessToken;
    }

    // Try to refresh — outside the lock to avoid blocking concurrent readers
    // during the 15s network call.
    //
    // No refresh_token → terminal: nothing to rotate, session is dead.
    // No metadata → TRANSIENT: discovery may have temporarily failed
    // (process restart while AS is briefly unreachable). Preserve tokens
    // so the next attempt can recover; do not destroy a refresh token
    // we cannot prove is invalid.
    if (tokens.refreshToken === undefined) {
      await storage.withLock(storageKey, () => storage.delete(storageKey));
      return undefined;
    }

    // Capture the refresh token we used — needed for compare-and-swap below
    const usedRefreshToken = tokens.refreshToken;

    // Resolve clientId LAZILY here — never during the no-tokens probe
    // above. For DCR-backed configs this triggers registration only
    // when there is something to refresh.
    let resolution: ClientResolution;
    try {
      resolution = await resolveClientId();
    } catch {
      // Resolver threw — treat as transient so a network blip cannot
      // wipe a valid refresh token.
      resolution = { kind: "transient" };
    }

    if (resolution.kind === "transient") {
      // DCR resolver failed transiently. Preserve tokens; the next
      // getAccessToken() attempt re-resolves.
      return undefined;
    }
    if (resolution.kind === "terminal") {
      // No static clientId AND no usable registration_endpoint — there
      // is no path to ever refresh again without operator intervention.
      // Clear stored tokens so the connection's 401 path can transition
      // to auth-needed instead of leaving the session permanently stuck
      // with undeletable expired credentials.
      await storage.withLock(storageKey, () => storage.delete(storageKey));
      return undefined;
    }
    const resolvedClient = resolution.client;
    const refreshClientId: string | undefined =
      resolvedClient.clientId === "" ? undefined : resolvedClient.clientId;

    // Read metadata AFTER client resolution. resolveClientId may have
    // re-discovered metadata as part of its DCR recovery path (degraded
    // snapshot recovery in the provider). The token endpoint we POST to
    // MUST belong to the same issuer the client_id was registered
    // with — otherwise we send a freshly registered client to a stale
    // token endpoint from the earlier degraded discovery and get
    // invalid_client / token loss.
    const currentMetadata = await resolveMetadata();
    if (currentMetadata === undefined) {
      return undefined;
    }

    let refreshResult = await refreshAccessToken(
      usedRefreshToken,
      currentMetadata.tokenEndpoint,
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
        currentMetadata.tokenEndpoint,
        refreshClientId,
        undefined,
      );
    }

    // Surface invalid_client to the provider so it can drop the persisted
    // DCR client BEFORE the next interactive auth. Pass the EXACT
    // clientId we used on the failing request — reading a mutable
    // provider cache here would race with concurrent flows that may
    // have already re-registered a fresh client between the failing
    // request and this callback firing.
    if (
      !refreshResult.ok &&
      refreshResult.invalidClient &&
      onInvalidClient !== undefined &&
      refreshClientId !== undefined
    ) {
      try {
        await onInvalidClient(resolvedClient);
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
 * Storage key for dynamically-registered client info. Keyed by the
 * full DCR identity contract — `serverName` + `serverUrl` +
 * `redirectUri` + `authority`.
 *
 * `serverName` IS part of the key by default: two separate `.mcp.json`
 * entries for the same URL represent distinct logical principals
 * (operators may multiplex the same endpoint by headers or by tenant
 * and must not share OAuth state). The earlier URL-only keying
 * created a tenant-isolation hazard whenever the same AS fronted
 * multiple logical configs.
 *
 * Tradeoff: renaming an alias invalidates the cached DCR registration
 * (next auth re-registers). That is the safer default. Operators who
 * want stable alias-independent caching can explicitly share
 * registrations via a future opt-in config; we prefer leaking one
 * DCR orphan on rename over cross-contaminating distinct tenants.
 *
 * Format: `mcp-oauth-client|{sha256(serverName + "|" + serverUrl + "|" + redirectUri + "|" + authority)[:16]}`.
 */
export function computeClientKey(
  serverName: string,
  serverUrl: string,
  redirectUri: string,
  authority: string = "",
): string {
  const hash = createHash("sha256")
    .update(`${serverName}|${serverUrl}|${redirectUri}|${authority}`)
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
      //
      // RFC 8707 §2: only `invalid_target` is the resource-parameter
      // rejection. `invalid_request` is the general OAuth catch-all
      // (PKCE mismatch, malformed body, duplicated params) — replaying
      // refresh on it could escalate a malformed request into harder-
      // to-recover token loss while doubling endpoint traffic.
      const terminal = response.status < 500;
      const errorCode = terminal ? await readErrorCode(response) : undefined;
      return {
        ok: false,
        terminal,
        invalidClient: errorCode === "invalid_client",
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
