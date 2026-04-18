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
  /** Issuer this registration is bound to — persisted so stale clients invalidate on discovery changes. */
  readonly issuer?: string | undefined;
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
  const { registrationEndpoint, redirectUri, clientName, issuer } = options;

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
      readonly token_endpoint_auth_method?: unknown;
    };

    if (typeof data.client_id !== "string" || data.client_id.length === 0) {
      return undefined;
    }

    // Fail fast on confidential registrations. We requested
    // `token_endpoint_auth_method: none` (public client + PKCE). If the AS
    // returned a client_secret or a confidential auth method, the later
    // token exchange and refresh paths — which only send client_id — would
    // fail with invalid_client. Rather than silently persist credentials
    // we can't use, drop the registration so callers fail closed at auth
    // time with a clear "try again" signal.
    if (
      typeof data.client_secret === "string" ||
      (typeof data.token_endpoint_auth_method === "string" &&
        data.token_endpoint_auth_method !== "none")
    ) {
      return undefined;
    }

    return {
      clientId: data.client_id,
      registeredAt: Date.now(),
      issuer,
      registrationEndpoint,
    };
  } catch {
    return undefined;
  }
}
