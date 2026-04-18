/**
 * Dynamic Client Registration — RFC 7591.
 *
 * Registers a public OAuth client with the authorization server's
 * `registration_endpoint` so operators do not need to pre-register an
 * app per MCP server. Output is a stable `OAuthClientInfo` that the
 * provider persists alongside tokens.
 */

import type { OAuthClientInfo } from "./types.js";

const REGISTRATION_TIMEOUT_MS = 15_000;
const DEFAULT_CLIENT_NAME = "Koi";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegisterClientOptions {
  readonly registrationEndpoint: string;
  readonly redirectUri: string;
  readonly clientName?: string | undefined;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers a public OAuth client. Throws on non-HTTPS endpoints (prevents
 * registration credentials from flowing over cleartext). Returns undefined
 * for any other failure — callers decide whether to fall back to configured
 * clientId or fail closed.
 */
export async function registerDynamicClient(
  options: RegisterClientOptions,
): Promise<OAuthClientInfo | undefined> {
  const { registrationEndpoint, redirectUri, clientName } = options;

  if (!registrationEndpoint.startsWith("https://")) {
    throw new Error(`registration_endpoint must use https:// (got: ${registrationEndpoint})`);
  }

  const requestBody = {
    client_name: clientName ?? DEFAULT_CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  try {
    const response = await fetch(registrationEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(REGISTRATION_TIMEOUT_MS),
    });

    if (!response.ok) return undefined;

    const data = (await response.json()) as {
      readonly client_id?: unknown;
      readonly client_secret?: unknown;
    };

    if (typeof data.client_id !== "string" || data.client_id.length === 0) {
      return undefined;
    }

    return {
      clientId: data.client_id,
      clientSecret: typeof data.client_secret === "string" ? data.client_secret : undefined,
      registeredAt: Date.now(),
    };
  } catch {
    return undefined;
  }
}
