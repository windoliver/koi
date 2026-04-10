/**
 * OAuth authorization server metadata discovery.
 *
 * Implements RFC 9728 (Protected Resource Metadata) → RFC 8414
 * (Authorization Server Metadata) discovery chain. Falls back to
 * configured metadata URL if provided.
 */

import type { AuthServerMetadata, McpOAuthConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCOVERY_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discovers the OAuth authorization server for an MCP server.
 *
 * Discovery order:
 * 1. If `config.authServerMetadataUrl` is set, fetch directly (must be HTTPS)
 * 2. RFC 9728: probe `/.well-known/oauth-protected-resource` on the MCP server
 * 3. RFC 8414: probe `/.well-known/oauth-authorization-server` on the MCP server
 *
 * Returns undefined if no OAuth metadata is found (server doesn't require OAuth).
 */
export async function discoverAuthServer(
  serverUrl: string,
  config?: McpOAuthConfig,
): Promise<AuthServerMetadata | undefined> {
  // 1. Configured metadata URL takes priority
  if (config?.authServerMetadataUrl !== undefined) {
    if (!config.authServerMetadataUrl.startsWith("https://")) {
      throw new Error(
        `authServerMetadataUrl must use https:// (got: ${config.authServerMetadataUrl})`,
      );
    }
    return fetchMetadata(config.authServerMetadataUrl);
  }

  // 2. RFC 9728: Protected Resource Metadata
  const resourceMeta = await fetchResourceMetadata(serverUrl);
  if (resourceMeta !== undefined) {
    return resourceMeta;
  }

  // 3. RFC 8414: Authorization Server Metadata (path-aware)
  return fetchAuthServerMetadata(serverUrl);
}

// ---------------------------------------------------------------------------
// RFC 9728 — Protected Resource Metadata
// ---------------------------------------------------------------------------

async function fetchResourceMetadata(serverUrl: string): Promise<AuthServerMetadata | undefined> {
  const url = new URL(serverUrl);
  // Path-aware: /.well-known/oauth-protected-resource/{path}
  const pathSuffix = url.pathname === "/" ? "" : url.pathname;
  const wellKnown = new URL(`/.well-known/oauth-protected-resource${pathSuffix}`, url);

  try {
    const response = await fetchWithTimeout(wellKnown.toString());
    if (!response.ok) return undefined;

    const body = (await response.json()) as {
      readonly authorization_servers?: readonly string[];
    };
    const asUrl = body.authorization_servers?.[0];
    if (asUrl === undefined) return undefined;

    // Fetch the AS metadata using RFC 8414 path insertion semantics
    return fetchAuthServerMetadata(asUrl);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// RFC 8414 — Authorization Server Metadata
// ---------------------------------------------------------------------------

async function fetchAuthServerMetadata(serverUrl: string): Promise<AuthServerMetadata | undefined> {
  const url = new URL(serverUrl);
  // Path-aware: /.well-known/oauth-authorization-server/{path}
  const pathSuffix = url.pathname === "/" ? "" : url.pathname;
  const wellKnown = new URL(`/.well-known/oauth-authorization-server${pathSuffix}`, url);

  return fetchMetadata(wellKnown.toString());
}

// ---------------------------------------------------------------------------
// Shared metadata fetch + validation
// ---------------------------------------------------------------------------

async function fetchMetadata(metadataUrl: string): Promise<AuthServerMetadata | undefined> {
  try {
    const response = await fetchWithTimeout(metadataUrl);
    if (!response.ok) return undefined;

    const body = (await response.json()) as Record<string, unknown>;

    // Validate required fields per RFC 8414 §2
    if (
      typeof body.issuer !== "string" ||
      typeof body.authorization_endpoint !== "string" ||
      typeof body.token_endpoint !== "string"
    ) {
      return undefined;
    }

    return {
      issuer: body.issuer,
      authorizationEndpoint: body.authorization_endpoint,
      tokenEndpoint: body.token_endpoint,
      registrationEndpoint:
        typeof body.registration_endpoint === "string" ? body.registration_endpoint : undefined,
      codeChallengeMethodsSupported: Array.isArray(body.code_challenge_methods_supported)
        ? (body.code_challenge_methods_supported as string[])
        : undefined,
    };
  } catch {
    return undefined;
  }
}

function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
}
