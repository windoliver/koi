/**
 * @koi/channel-teams — Bot Framework outbound bearer-token minter.
 *
 * Performs the OAuth2 client-credentials flow against the Microsoft
 * identity platform and caches the token until shortly before expiry:
 *
 *   POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
 *     grant_type=client_credentials
 *     client_id=<appId>
 *     client_secret=<appPassword>
 *     scope=https://api.botframework.com/.default
 *
 * `appPassword` from `TeamsConfig` is consumed exclusively here; outbound
 * `send()` uses the minted bearer, NOT the password directly. Bot
 * Framework rejects raw passwords as Bearer tokens, so previous behaviour
 * (where consumers had to supply a custom `mintAppToken`) was an obscure
 * production blocker.
 */

import type { CloudProfile, TeamsConfig } from "./config.js";

function resolveCloudEndpoints(cloud: CloudProfile): { tenant: string; scope: string } {
  if (cloud === "public") {
    return {
      tenant: "botframework.com",
      scope: "https://api.botframework.com/.default",
    };
  }
  if (cloud === "gov") {
    return {
      tenant: "botframework.azure.us",
      scope: "https://api.botframework.us/.default",
    };
  }
  // Inline cloud profile: callers supply explicit issuer/jwksUri for
  // verification, but the mint endpoints come from options or fall
  // through to the public defaults if neither is supplied. Inline
  // profiles SHOULD pass options.tenant/options.scope explicitly.
  return {
    tenant: "botframework.com",
    scope: "https://api.botframework.com/.default",
  };
}

export type MintAppTokenOptions = {
  readonly tenant?: string;
  readonly scope?: string;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly clock?: () => number;
  /** Refresh threshold; default 60s before expiry. */
  readonly refreshSkewMs?: number;
};

type CachedToken = { readonly token: string; readonly expiresAt: number };

export function createBotFrameworkAppTokenMinter(
  config: Pick<TeamsConfig, "appId" | "appPassword" | "cloud">,
  options: MintAppTokenOptions = {},
): () => Promise<string> {
  // Derive tenant + scope from the configured cloud profile.
  // Public cloud authenticates via `botframework.com` against the
  // `https://api.botframework.com/.default` resource. US Gov cloud
  // authenticates via `botframework.azure.us` against
  // `https://api.botframework.us/.default`. Hardcoding public-cloud
  // values would let a gov-cloud webhook authenticate (issuer
  // accepted by the verifier) but every outbound send fail at the
  // wrong authority — a silent gov-deployment outage. Inline
  // overrides remain available via options.tenant/options.scope for
  // private-cloud or test scenarios.
  const cloudDefaults = resolveCloudEndpoints(config.cloud);
  const tenant = options.tenant ?? cloudDefaults.tenant;
  const scope = options.scope ?? cloudDefaults.scope;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const clock = options.clock ?? Date.now;
  const refreshSkewMs = options.refreshSkewMs ?? 60_000;
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;

  // `let` justified: cache mutates on each refresh.
  let cached: CachedToken | null = null;
  // `let` justified: in-flight de-dup so concurrent callers share one fetch.
  let pending: Promise<string> | null = null;

  const refresh = async (): Promise<string> => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.appId,
      client_secret: config.appPassword,
      scope,
    });
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`AUTH_FAILED: token endpoint HTTP ${res.status}`);
    }
    const json: unknown = await res.json();
    if (
      typeof json !== "object" ||
      json === null ||
      !("access_token" in json) ||
      typeof json.access_token !== "string"
    ) {
      throw new Error("AUTH_FAILED: token response missing access_token");
    }
    const expiresIn =
      "expires_in" in json && typeof json.expires_in === "number" ? json.expires_in : 3600;
    cached = {
      token: json.access_token,
      expiresAt: clock() + expiresIn * 1000,
    };
    return cached.token;
  };

  return async () => {
    if (cached && cached.expiresAt - clock() > refreshSkewMs) {
      return cached.token;
    }
    if (pending) return pending;
    pending = refresh().finally(() => {
      pending = null;
    });
    return pending;
  };
}
