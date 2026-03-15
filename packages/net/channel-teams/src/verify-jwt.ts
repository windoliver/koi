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
 * Creates an authenticator that validates Bot Framework JWTs.
 *
 * The JWKS is fetched and cached by `jose` automatically, including
 * key rotation handling.
 *
 * @param appId - The Azure AD application ID (used as the expected `aud` claim)
 */
export function createBotFrameworkAuthenticator(appId: string): BotFrameworkAuthenticator {
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

      // Validate issuer starts with https:// (Bot Framework issuers)
      if (typeof payload.iss !== "string" || !payload.iss.startsWith("https://")) {
        return { ok: false, reason: "invalid_token" };
      }

      return { ok: true };
    } catch {
      return { ok: false, reason: "invalid_token" };
    }
  };

  return { verify };
}
