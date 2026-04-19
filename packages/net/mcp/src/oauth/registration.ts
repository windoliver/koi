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

  // Network-level failures (DNS, connection refused, AbortSignal
  // timeout) are transient — operator action cannot fix them; the next
  // attempt may succeed.
  let response: Response;
  try {
    response = await fetch(registrationEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(REGISTRATION_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, terminal: false, reason: "network or timeout error" };
  }

  if (!response.ok) {
    // 5xx = transient (server-side hiccup). 429 and other retryable
    // throttling responses also stay transient — they typically clear
    // on retry without operator intervention. Other 4xx (400, 401,
    // 403, 422 validation) = terminal: the AS rejected our request
    // shape and we cannot succeed by retrying.
    const isThrottled = response.status === 429;
    const terminal = response.status < 500 && !isThrottled;
    return {
      ok: false,
      terminal,
      reason: `registration endpoint returned ${response.status}`,
    };
  }

  // Once we have a 2xx, malformed JSON or missing fields are TERMINAL —
  // the AS replied successfully but with an unusable payload. Retrying
  // will not change that without operator/server-side fix. Without this
  // distinction, a broken-payload server would loop forever as
  // transient with handleUnauthorized never firing onReauthNeeded.
  let data: {
    readonly client_id?: unknown;
    readonly client_secret?: unknown;
    readonly token_endpoint_auth_method?: unknown;
    readonly redirect_uris?: unknown;
    readonly registration_client_uri?: unknown;
    readonly registration_access_token?: unknown;
  };
  try {
    data = (await response.json()) as typeof data;
  } catch {
    return {
      ok: false,
      terminal: true,
      reason: "registration response was not valid JSON",
    };
  }

  // Capture the RFC 7592 client-management metadata BEFORE any
  // post-2xx validation can early-return — a 201 may have created the
  // client server-side even when the response is structurally invalid
  // (e.g. missing client_id). Without rolling those back too, retries
  // would leak a fresh orphan on every attempt.
  //
  // The URI is validated against the registration endpoint origin
  // (HTTPS + same host + strict child path) and rollback requires both
  // URI and bearer token — see isSafeManagementUri / rollback below.
  const cleanupUri =
    typeof data.registration_client_uri === "string" &&
    isSafeManagementUri(data.registration_client_uri, registrationEndpoint)
      ? data.registration_client_uri
      : undefined;
  const cleanupToken =
    typeof data.registration_access_token === "string" ? data.registration_access_token : undefined;
  const rollback = async (): Promise<void> => {
    if (cleanupUri === undefined || cleanupToken === undefined) return;
    await deleteRegisteredClient(cleanupUri, cleanupToken);
  };

  try {
    if (typeof data.client_id !== "string" || data.client_id.length === 0) {
      await rollback();
      return {
        ok: false,
        terminal: true,
        reason: "registration response missing client_id",
      };
    }

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
        // Opaque per-registration generation token. Random UUID so
        // CAS invalidation cannot match a different registration that
        // happens to share the same client_id (deterministic reissue)
        // or land in the same wall-clock millisecond (fast retries).
        generation: crypto.randomUUID(),
        issuer,
        registrationEndpoint,
      },
    };
  } catch {
    // Defensive: by this point we have a 2xx + parsed JSON, so any
    // further throw is a bug or unexpected runtime error, not a
    // network/transient issue. Treat as terminal so we don't loop.
    return { ok: false, terminal: true, reason: "unexpected error after registration" };
  }
}

/**
 * Validates a candidate RFC 7592 management URI before we will issue
 * an authenticated DELETE to it. Constraints:
 *
 *   1. URI must parse and use the `https:` scheme.
 *   2. Origin (scheme + host + port) must match the registration endpoint.
 *   3. No query string or fragment — the management resource is the
 *      whole URL identity, anything else is suspect.
 *   4. Path must NOT contain percent-encoded slashes (`%2F`) or dot
 *      segments (`%2e` / encoded `.`/`..`). Routers commonly decode
 *      these AFTER our string compare, smuggling a path-traversal
 *      target past a naive prefix check.
 *   5. Decoded path segments must be either the literal registration
 *      endpoint path or strictly extend it by one or more child
 *      segments. Equality is rejected (would target the collection).
 *   6. No `.` or `..` segments anywhere in the decoded path.
 *
 * Without these checks a compromised or buggy registration response
 * could direct rollback at an unrelated DELETE-capable endpoint and
 * exfiltrate the bearer management token.
 */
function isSafeManagementUri(candidate: string, registrationEndpoint: string): boolean {
  try {
    const u = new URL(candidate);
    if (u.protocol !== "https:") return false;
    if (u.search !== "" || u.hash !== "") return false;

    const reg = new URL(registrationEndpoint);
    if (u.origin !== reg.origin) return false;

    // Reject encoded slashes / dots so we cannot be confused by a
    // server-side decoder that normalizes them after our prefix check.
    const lower = u.pathname.toLowerCase();
    if (lower.includes("%2f") || lower.includes("%5c") || lower.includes("%2e")) {
      return false;
    }

    // Decode and split into segments so we can check shape structurally.
    const decoded = decodeSafePathname(u.pathname);
    if (decoded === undefined) return false;
    const regDecoded = decodeSafePathname(reg.pathname);
    if (regDecoded === undefined) return false;
    if (decoded === regDecoded) return false;

    const candidateSegments = decoded.split("/").filter((s) => s.length > 0);
    const regSegments = regDecoded.split("/").filter((s) => s.length > 0);
    if (candidateSegments.length <= regSegments.length) return false;
    for (const [i, seg] of regSegments.entries()) {
      if (candidateSegments[i] !== seg) return false;
    }
    // Forbid any traversal segment after the prefix.
    for (const seg of candidateSegments.slice(regSegments.length)) {
      if (seg === "." || seg === "..") return false;
      if (seg.length === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode percent-encoded path safely. Returns undefined on malformed
 * encodings so callers can fail-closed rather than substitute a
 * potentially-different decoded value. Wrap separate from the URL
 * parse so we surface decoding failures explicitly.
 */
function decodeSafePathname(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
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
