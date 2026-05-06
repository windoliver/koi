/**
 * @koi/channel-teams — Bot Framework JWT verifier.
 *
 * Validation order (rejects with first failure):
 *   1. `Bearer <token>` header shape           → INVALID_JWT
 *   2. JWT signature against issuer-paired JWKS → INVALID_JWT
 *   3. `aud` matches configured appId          → AUDIENCE_MISMATCH
 *   4. `tid` in tenantAllowlist (unless ["*"]) → TENANT_NOT_ALLOWED
 *   5. `iss` matches resolved issuer           → INVALID_JWT
 *   6. `exp`/`nbf` within 60s skew             → INVALID_JWT
 *   7. activity.serviceUrl in serviceUrlAllowlist → SERVICE_URL_NOT_ALLOWED
 *
 * The `jose` library is hidden behind a small DI seam so tests can inject
 * a fake `verifyToken` instead of mocking remote JWKS.
 */

import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { ServiceUrlPattern, TeamsConfig } from "./config.js";
import { createBotFrameworkAppTokenMinter } from "./mint-app-token.js";

export type TeamsErrorCode =
  | "INVALID_JWT"
  | "AUDIENCE_MISMATCH"
  | "TENANT_NOT_ALLOWED"
  | "SERVICE_URL_NOT_ALLOWED"
  | "AUTH_FAILED"
  /** Verifier dependency failure (JWKS fetch error, DNS, transient
   * network). Distinct from INVALID_JWT (signature/claim failure) so
   * the webhook handler can return 503 (retryable) instead of 401
   * (Bot Framework will not reliably retry 401, dropping valid
   * traffic during a JWKS outage). */
  | "VERIFIER_UNAVAILABLE";

export type VerifiedClaims = {
  readonly aud: string;
  readonly tid: string;
  readonly iss: string;
  readonly exp: number;
  readonly nbf: number;
};

export type VerifyResult =
  | { readonly ok: true; readonly claims: VerifiedClaims }
  | { readonly ok: false; readonly code: TeamsErrorCode; readonly message: string };

export interface JwtVerifier {
  verify(rawAuthHeader: string, activity: { readonly serviceUrl: string }): Promise<VerifyResult>;
  appToken(): Promise<string>;
}

const PUBLIC_ISSUER = "https://api.botframework.com";
const GOV_ISSUER = "https://api.botframework.us";
const PUBLIC_JWKS_URI = "https://login.botframework.com/v1/.well-known/keys";
const GOV_JWKS_URI = "https://login.botframework.us/v1/.well-known/keys";
const SKEW_MS = 60_000;

export function resolveIssuer(config: TeamsConfig): {
  readonly issuer: string;
  readonly jwksUri: string;
} {
  if (config.cloud === "public") return { issuer: PUBLIC_ISSUER, jwksUri: PUBLIC_JWKS_URI };
  if (config.cloud === "gov") return { issuer: GOV_ISSUER, jwksUri: GOV_JWKS_URI };
  return { issuer: config.cloud.issuer, jwksUri: config.cloud.jwksUri };
}

function stripPort(host: string): string {
  const i = host.indexOf(":");
  if (i < 0) return host.toLowerCase();
  const port = host.slice(i + 1);
  if (port === "443") return host.slice(0, i).toLowerCase();
  return host.toLowerCase();
}

export function matchServiceUrl(url: string, allowlist: readonly ServiceUrlPattern[]): boolean {
  // `let` justified: URL constructor may throw, requires conditional init.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = stripPort(parsed.host);
  for (const p of allowlist) {
    const pHost = p.host.toLowerCase();
    if (p.hostMatch === "exact") {
      if (host === pHost) return true;
    } else {
      // subdomain: literal host OR dot-boundary descendant.
      if (host === pHost) return true;
      if (host.endsWith(`.${pHost}`)) return true;
    }
  }
  return false;
}

export type ClaimsInput = {
  readonly aud?: unknown;
  readonly tid?: unknown;
  readonly iss?: unknown;
  readonly exp?: unknown;
  readonly nbf?: unknown;
};

export function validateClaims(
  payload: ClaimsInput,
  config: TeamsConfig,
  expectedIssuer: string,
  now: number,
): VerifyResult {
  const aud = payload.aud;
  if (typeof aud !== "string" || aud !== config.appId) {
    return { ok: false, code: "AUDIENCE_MISMATCH", message: "aud claim does not match appId" };
  }
  const tid = payload.tid;
  if (typeof tid !== "string" || tid.length === 0) {
    return { ok: false, code: "TENANT_NOT_ALLOWED", message: "tid claim missing" };
  }
  const wildcard = config.tenantAllowlist.length === 1 && config.tenantAllowlist[0] === "*";
  if (!wildcard && !config.tenantAllowlist.includes(tid)) {
    return { ok: false, code: "TENANT_NOT_ALLOWED", message: `tenant ${tid} not in allowlist` };
  }
  const iss = payload.iss;
  if (typeof iss !== "string" || iss !== expectedIssuer) {
    return { ok: false, code: "INVALID_JWT", message: "iss claim does not match expected issuer" };
  }
  const exp = payload.exp;
  const nbf = payload.nbf;
  if (typeof exp !== "number" || typeof nbf !== "number") {
    return { ok: false, code: "INVALID_JWT", message: "exp/nbf claims missing" };
  }
  const expMs = exp * 1000;
  const nbfMs = nbf * 1000;
  if (now > expMs + SKEW_MS) {
    return { ok: false, code: "INVALID_JWT", message: "token expired" };
  }
  if (now + SKEW_MS < nbfMs) {
    return { ok: false, code: "INVALID_JWT", message: "token not yet valid" };
  }
  return { ok: true, claims: { aud, tid, iss, exp, nbf } };
}

function parseBearer(header: string): string | null {
  if (header.length === 0) return null;
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;
  const token = parts[1];
  return token !== undefined && token.length > 0 ? token : null;
}

export type VerifyTokenFn = (token: string) => Promise<JWTPayload>;

export type CreateTokenVerifierOptions = {
  readonly verifyToken?: VerifyTokenFn;
  /**
   * Optional override for the Bot Framework outbound app-token minter.
   * When omitted, the verifier defaults to
   * `createBotFrameworkAppTokenMinter(config)` — the in-package OAuth2
   * client-credentials minter. Override only for tests, custom IDPs, or
   * inline cloud profiles that need a custom token endpoint.
   */
  readonly mintAppToken?: () => Promise<string>;
  readonly clock?: () => number;
};

export function createTokenVerifier(
  config: TeamsConfig,
  options: CreateTokenVerifierOptions = {},
): JwtVerifier {
  const { issuer, jwksUri } = resolveIssuer(config);
  const clock = options.clock ?? Date.now;
  // Default to the package's Bot Framework client-credentials minter
  // when the caller does not supply one. The default is safe for
  // public + gov clouds — it derives tenant + scope from
  // `config.cloud` and mints against the correct authority. Inline
  // clouds (`{issuer, jwksUri}`) have no safe default token endpoint
  // (TeamsConfig carries no outbound tenant/scope), so the verifier
  // refuses to auto-construct one and requires the caller to pass
  // `options.mintAppToken` explicitly. Otherwise the verifier would
  // throw at construction time even on inbound-only deployments.
  const mintAppToken: () => Promise<string> = (() => {
    if (options.mintAppToken !== undefined) return options.mintAppToken;
    if (config.cloud === "public" || config.cloud === "gov") {
      return createBotFrameworkAppTokenMinter(config);
    }
    // Inline cloud: appToken() is only invoked on outbound send. Defer
    // failure until then so inbound-only callers can still construct
    // the verifier; outbound callers get a clear INVALID_CONFIG.
    return async (): Promise<string> => {
      throw new Error(
        "INVALID_CONFIG: inline cloud profile requires options.mintAppToken — no default Bot Framework minter exists for inline clouds (no safe tenant/scope)",
      );
    };
  })();
  // Construct the remote JWKS resolver ONCE per verifier instance.
  // jose's resolver caches keys + cooldown timers internally; recreating
  // it per-request defeats that cache and turns each webhook into a
  // live JWKS fetch — under load or transient Microsoft/DNS issues,
  // valid traffic returns VERIFIER_UNAVAILABLE/503 far more often than
  // intended. Hoist outside the verifyToken closure so all calls share
  // the same memoized state.
  const sharedJwks = createRemoteJWKSet(new URL(jwksUri));
  const verifyToken: VerifyTokenFn =
    options.verifyToken ??
    (async (token: string): Promise<JWTPayload> => {
      const { payload } = await jwtVerify(token, sharedJwks);
      return payload;
    });

  const verify = async (
    rawAuthHeader: string,
    activity: { readonly serviceUrl: string },
  ): Promise<VerifyResult> => {
    const token = parseBearer(rawAuthHeader);
    if (token === null) {
      return {
        ok: false,
        code: "INVALID_JWT",
        message: "missing or malformed Authorization header",
      };
    }
    // `let` justified: payload assignment must happen inside try/catch.
    let payload: JWTPayload;
    try {
      payload = await verifyToken(token);
    } catch (e) {
      // Classify: signature/claim failures from `jose` carry a `code`
      // starting with "ERR_JW" (e.g. ERR_JWS_SIGNATURE_VERIFICATION_FAILED,
      // ERR_JWT_CLAIM_VALIDATION_FAILED, ERR_JWT_EXPIRED). Anything else
      // — TypeError on a fetch failure, AbortError, "fetch failed",
      // network errors thrown by createRemoteJWKSet — is a verifier
      // dependency outage and MUST be retryable so a transient JWKS
      // problem does not silently drop user traffic.
      const errCode =
        typeof (e as { readonly code?: unknown }).code === "string"
          ? (e as { readonly code: string }).code
          : "";
      const msg = e instanceof Error ? e.message : "signature verification failed";
      if (errCode.startsWith("ERR_JW")) {
        return { ok: false, code: "INVALID_JWT", message: msg };
      }
      return { ok: false, code: "VERIFIER_UNAVAILABLE", message: msg };
    }
    const claims = validateClaims(payload, config, issuer, clock());
    if (!claims.ok) return claims;
    if (!matchServiceUrl(activity.serviceUrl, config.serviceUrlAllowlist)) {
      return {
        ok: false,
        code: "SERVICE_URL_NOT_ALLOWED",
        message: `serviceUrl ${activity.serviceUrl} not in allowlist`,
      };
    }
    return claims;
  };

  return { verify, appToken: mintAppToken };
}
