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

export type TeamsErrorCode =
  | "INVALID_JWT"
  | "AUDIENCE_MISMATCH"
  | "TENANT_NOT_ALLOWED"
  | "SERVICE_URL_NOT_ALLOWED"
  | "AUTH_FAILED";

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
   * REQUIRED for production deployments. Mints a Bot Framework OAuth2 access
   * token (client credentials flow against
   * https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token, scope
   * `https://api.botframework.com/.default`) with caching/expiry handling.
   * The package does NOT ship a default implementation because there is no
   * safe default — using `appPassword` directly as a Bearer token is rejected
   * by Bot Framework and would silently break outbound sends.
   */
  readonly mintAppToken: () => Promise<string>;
  readonly clock?: () => number;
};

export function createTokenVerifier(
  config: TeamsConfig,
  options: CreateTokenVerifierOptions,
): JwtVerifier {
  const { issuer, jwksUri } = resolveIssuer(config);
  const clock = options.clock ?? Date.now;
  const verifyToken: VerifyTokenFn =
    options.verifyToken ??
    (async (token: string): Promise<JWTPayload> => {
      const jwks = createRemoteJWKSet(new URL(jwksUri));
      const { payload } = await jwtVerify(token, jwks);
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
      const msg = e instanceof Error ? e.message : "signature verification failed";
      return { ok: false, code: "INVALID_JWT", message: msg };
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

  return { verify, appToken: options.mintAppToken };
}
