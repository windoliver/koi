/**
 * Bot Framework JWT authentication for incoming webhook requests.
 *
 * Validates the Authorization header against Microsoft's JWKS endpoint
 * to ensure requests originate from the Bot Framework.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

/** Result of verifying a Bot Framework JWT. */
export type BotFrameworkAuthResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Authenticator object returned by createBotFrameworkAuthenticator. */
export interface BotFrameworkAuthenticator {
  /** Verify the Authorization header on an incoming request. */
  readonly verify: (request: Request) => Promise<BotFrameworkAuthResult>;
}

/** Microsoft Bot Framework JWKS endpoint for token signing keys. */
const BOT_FRAMEWORK_JWKS_URL = "https://login.botframework.com/v1/.well-known/keys";

/**
 * Known Bot Framework / Azure AD issuer prefixes.
 * Tokens from the Bot Connector service are issued by these authorities.
 * This allowlist prevents accepting tokens signed by Microsoft keys but
 * issued for unrelated services.
 */
const KNOWN_ISSUER_PREFIXES: readonly string[] = [
  "https://login.microsoftonline.com/",
  "https://sts.windows.net/",
  "https://api.botframework.com",
] as const;

function isKnownBotFrameworkIssuer(iss: string): boolean {
  return KNOWN_ISSUER_PREFIXES.some((prefix) => iss.startsWith(prefix));
}

/**
 * Creates an authenticator that validates Bot Framework JWTs.
 *
 * The JWKS is fetched and cached by `jose` automatically, including
 * key rotation handling.
 *
 * @param appId - The Azure AD application ID (used as the expected `aud` claim)
 * @param tenantId - Optional Azure AD tenant ID for single-tenant deployments.
 *   When provided, the JWT's `tid` claim must match exactly.
 */
export function createBotFrameworkAuthenticator(
  appId: string,
  tenantId?: string,
): BotFrameworkAuthenticator {
  const jwks = createRemoteJWKSet(new URL(BOT_FRAMEWORK_JWKS_URL));

  const verify = async (request: Request): Promise<BotFrameworkAuthResult> => {
    const authHeader = request.headers.get("authorization");
    if (authHeader === null || authHeader === "") {
      return { ok: false, reason: "missing_auth_header" };
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return { ok: false, reason: "missing_auth_header" };
    }

    const token = parts[1];
    if (token === undefined || token === "") {
      return { ok: false, reason: "missing_auth_header" };
    }

    try {
      const { payload } = await jwtVerify(token, jwks);

      // Validate audience matches our app ID
      if (payload.aud !== appId) {
        return { ok: false, reason: "invalid_token" };
      }

      // Validate issuer is a known Bot Framework / Azure AD issuer.
      // Bot Framework tokens are issued by login.microsoftonline.com or sts.windows.net.
      if (typeof payload.iss !== "string" || !isKnownBotFrameworkIssuer(payload.iss)) {
        return { ok: false, reason: "invalid_token" };
      }

      // Enforce tenant isolation when tenantId is configured
      if (tenantId !== undefined) {
        const tokenTenantId = payload.tid;
        if (tokenTenantId !== tenantId) {
          return { ok: false, reason: "tenant_mismatch" };
        }
      }

      return { ok: true };
    } catch {
      return { ok: false, reason: "invalid_token" };
    }
  };

  return { verify };
}
