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
 * Discriminated result for `registerDynamicClient`. `terminal` failures
 * cannot succeed on retry without operator action — refresh paths that
 * see one should clear tokens and prompt re-auth, not preserve the
 * dead session forever. `transient` failures (network, 5xx, timeout)
 * may recover on the next attempt; preserve state.
 */
export type RegisterClientResult =
  | { readonly ok: true; readonly info: OAuthClientInfo }
  | { readonly ok: false; readonly terminal: boolean; readonly reason: string };

/**
 * Registers a public OAuth client. Returns a discriminated result so
 * callers can distinguish terminal misconfiguration (insecure endpoint,
 * confidential registration, narrowed redirect_uris, malformed
 * response) from transient outages (network, 5xx, timeout). Throws on
 * non-HTTPS endpoints (prevents registration credentials from flowing
 * over cleartext) — the throw is itself a terminal condition the
 * caller should classify as `terminal`.
 */
export async function registerDynamicClient(
  options: RegisterClientOptions,
): Promise<RegisterClientResult> {
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

    if (!response.ok) {
      // 4xx = terminal (AS rejected our registration request). 5xx =
      // transient (try later). The body may carry a richer reason but
      // we don't need to parse it for classification.
      const terminal = response.status < 500;
      return {
        ok: false,
        terminal,
        reason: `registration endpoint returned ${response.status}`,
      };
    }

    const data = (await response.json()) as {
      readonly client_id?: unknown;
      readonly client_secret?: unknown;
      readonly token_endpoint_auth_method?: unknown;
      readonly redirect_uris?: unknown;
      readonly registration_client_uri?: unknown;
      readonly registration_access_token?: unknown;
    };

    if (typeof data.client_id !== "string" || data.client_id.length === 0) {
      return {
        ok: false,
        terminal: true,
        reason: "registration response missing client_id",
      };
    }

    // Capture the RFC 7592 client-management metadata up front so any
    // post-validation rejection below can attempt to delete the orphan.
    // The URI is validated against the registration endpoint origin
    // (HTTPS + same host) before any DELETE — a malicious or compromised
    // AS could otherwise point `registration_client_uri` at an
    // attacker-controlled host and exfiltrate the management token
    // (SSRF / credential leak primitive).
    const cleanupUri =
      typeof data.registration_client_uri === "string" &&
      isSafeManagementUri(data.registration_client_uri, registrationEndpoint)
        ? data.registration_client_uri
        : undefined;
    const cleanupToken =
      typeof data.registration_access_token === "string"
        ? data.registration_access_token
        : undefined;
    const rollback = async (): Promise<void> => {
      if (cleanupUri === undefined) return;
      await deleteRegisteredClient(cleanupUri, cleanupToken);
    };

    // Require explicit confirmation of a public client.
    //
    // Per RFC 7591 §2, if `token_endpoint_auth_method` is omitted the
    // server defaults to `client_secret_basic` (confidential). We only
    // implement the public-client (`none`) path — token exchange and
    // refresh send only `client_id` — so a confidential registration
    // would later fail with `invalid_client`. Demand the AS echo
    // `token_endpoint_auth_method === "none"` rather than guess.
    // Also reject any returned `client_secret` defensively.
    if (typeof data.client_secret === "string" || data.token_endpoint_auth_method !== "none") {
      await rollback();
      return {
        ok: false,
        terminal: true,
        reason: "registration response is confidential (client_secret or non-`none` auth method)",
      };
    }

    // Validate the AS's accepted redirect URI contract. RFC 7591 §3.2.1
    // SHOULDs servers to echo metadata they actually accepted; when the
    // response includes `redirect_uris`, our requested URI MUST appear in
    // it — otherwise the AS narrowed/rewrote our callback and the next
    // authorization will fail with invalid_redirect_uri. Persisting that
    // registration would create a sticky failure across sessions.
    // When the field is absent we trust the request was accepted as-is.
    if (Array.isArray(data.redirect_uris)) {
      const accepted = data.redirect_uris.filter((u): u is string => typeof u === "string");
      if (!accepted.includes(redirectUri)) {
        await rollback();
        return {
          ok: false,
          terminal: true,
          reason: "registration response narrowed redirect_uris away from ours",
        };
      }
    }

    return {
      ok: true,
      info: {
        clientId: data.client_id,
        registeredAt: Date.now(),
        issuer,
        registrationEndpoint,
      },
    };
  } catch {
    // Network error, AbortSignal timeout, malformed JSON — transient.
    // Operator action cannot fix these; the next attempt may succeed.
    return { ok: false, terminal: false, reason: "network or parsing error" };
  }
}

/**
 * Validates a candidate RFC 7592 management URI before we will issue
 * an authenticated DELETE to it. Constraints:
 *
 *   1. URI must parse and use the `https:` scheme.
 *   2. Origin (host) must match the registration endpoint that issued it.
 *
 * A malicious or compromised registration response could otherwise
 * point `registration_client_uri` at an arbitrary host and turn rollback
 * into an SSRF + management-token exfiltration primitive.
 */
function isSafeManagementUri(candidate: string, registrationEndpoint: string): boolean {
  try {
    const u = new URL(candidate);
    if (u.protocol !== "https:") return false;
    const reg = new URL(registrationEndpoint);
    return u.host === reg.host;
  } catch {
    return false;
  }
}

/**
 * RFC 7592 client-management DELETE — best-effort cleanup of a freshly
 * registered DCR client we cannot use. Failures are intentionally
 * swallowed: we already decided not to persist this registration, so
 * surfacing a delete error to the caller would just mask the original
 * rejection reason. Worst case the orphan persists on the AS until
 * server-side TTLs expire, which is the same outcome as having no
 * cleanup at all. The caller is expected to have already validated
 * `registrationClientUri` via `isSafeManagementUri`.
 */
async function deleteRegisteredClient(
  registrationClientUri: string,
  registrationAccessToken: string | undefined,
): Promise<void> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (registrationAccessToken !== undefined) {
      headers.Authorization = `Bearer ${registrationAccessToken}`;
    }
    await fetch(registrationClientUri, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(REGISTRATION_TIMEOUT_MS),
    });
  } catch {
    // Best effort.
  }
}
