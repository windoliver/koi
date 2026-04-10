/**
 * Token manager — handles OAuth token persistence and refresh.
 *
 * Uses SecureStorage for persistence with file-locking for concurrent
 * access safety. Tokens are stored as JSON keyed by server identity.
 */

import { createHash } from "node:crypto";
import type { SecureStorage } from "@koi/secure-storage";
import type { AuthServerMetadata, OAuthTokens } from "./types.js";

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
  readonly clientId?: string | undefined;
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
  const { serverName, serverUrl, storage, metadata, clientId } = options;
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
    return storage.withLock(storageKey, async () => {
      const tokens = await getTokens();
      if (tokens === undefined) return undefined;

      // Check if access token is still valid
      if (!isExpired(tokens)) {
        return tokens.accessToken;
      }

      // Try to refresh
      if (tokens.refreshToken === undefined || metadata === undefined) {
        // Can't refresh — clear stale tokens
        await storage.delete(storageKey);
        return undefined;
      }

      const refreshed = await refreshAccessToken(
        tokens.refreshToken,
        metadata.tokenEndpoint,
        clientId,
      );
      if (refreshed === undefined) {
        // Refresh failed — clear tokens (likely invalid_grant)
        await storage.delete(storageKey);
        return undefined;
      }

      // Store refreshed tokens
      await storage.set(storageKey, JSON.stringify(refreshed));
      return refreshed.accessToken;
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

function isExpired(tokens: OAuthTokens): boolean {
  if (tokens.expiresAt === undefined) return false;
  return Date.now() >= tokens.expiresAt - EXPIRY_BUFFER_MS;
}

async function refreshAccessToken(
  refreshToken: string,
  tokenEndpoint: string,
  clientId?: string,
): Promise<OAuthTokens | undefined> {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (clientId !== undefined) {
      body.set("client_id", clientId);
    }

    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
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
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt:
        typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
      tokenType: data.token_type,
      scope: data.scope,
    };
  } catch {
    return undefined;
  }
}
