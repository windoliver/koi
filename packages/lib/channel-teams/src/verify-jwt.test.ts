import { describe, expect, test } from "bun:test";
import type { ServiceUrlPattern, TeamsConfig } from "./config.js";
import {
  createTokenVerifier,
  matchServiceUrl,
  resolveIssuer,
  validateClaims,
} from "./verify-jwt.js";

const baseConfig: TeamsConfig = {
  appId: "app-1",
  appPassword: "secret",
  tenantAllowlist: ["tenant-1"],
  cloud: "public",
  serviceUrlAllowlist: [
    { scheme: "https", host: "smba.trafficmanager.net", hostMatch: "exact" },
    { scheme: "https", host: "example.com", hostMatch: "subdomain" },
  ],
  production: false,
  handlerTimeoutMs: 300_000,
  commitTtlMs: 86_400_000,
};

describe("matchServiceUrl", () => {
  const allow: readonly ServiceUrlPattern[] = baseConfig.serviceUrlAllowlist;

  test("exact host match passes", () => {
    expect(matchServiceUrl("https://smba.trafficmanager.net/v3", allow)).toBe(true);
  });

  test("subdomain match passes for dot-boundary descendant", () => {
    expect(matchServiceUrl("https://a.example.com/x", allow)).toBe(true);
  });

  test("evilexample.com does NOT match example.com", () => {
    expect(matchServiceUrl("https://evilexample.com/x", allow)).toBe(false);
  });

  test("http:// always rejects", () => {
    expect(matchServiceUrl("http://smba.trafficmanager.net/v3", allow)).toBe(false);
  });

  test("default port :443 stripped", () => {
    expect(matchServiceUrl("https://smba.trafficmanager.net:443/v3", allow)).toBe(true);
  });

  test("non-default port still matches host", () => {
    // host comparison strips :443 but other ports are part of `parsed.host`.
    // A non-default port present means parsed.host still includes it; we require
    // exact-host-only after strip-port, so `:8080` would not match.
    expect(matchServiceUrl("https://smba.trafficmanager.net:8080/v3", allow)).toBe(false);
  });

  test("malformed url returns false", () => {
    expect(matchServiceUrl("not a url", allow)).toBe(false);
  });

  test("subdomain literal host also matches", () => {
    expect(matchServiceUrl("https://example.com/y", allow)).toBe(true);
  });
});

describe("resolveIssuer", () => {
  test("public", () => {
    expect(resolveIssuer(baseConfig).issuer).toBe("https://api.botframework.com");
  });
  test("gov", () => {
    expect(resolveIssuer({ ...baseConfig, cloud: "gov" }).issuer).toBe(
      "https://api.botframework.us",
    );
  });
  test("inline", () => {
    const r = resolveIssuer({
      ...baseConfig,
      cloud: { issuer: "https://issuer.test/", jwksUri: "https://jwks.test/" },
    });
    expect(r.issuer).toBe("https://issuer.test/");
    expect(r.jwksUri).toBe("https://jwks.test/");
  });
});

describe("validateClaims", () => {
  const issuer = "https://api.botframework.com";
  const now = 1_700_000_000_000; // ms
  const valid = {
    aud: "app-1",
    tid: "tenant-1",
    iss: issuer,
    exp: Math.floor(now / 1000) + 3600,
    nbf: Math.floor(now / 1000) - 60,
  };

  test("valid claims pass", () => {
    const r = validateClaims(valid, baseConfig, issuer, now);
    expect(r.ok).toBe(true);
  });

  test("aud mismatch", () => {
    const r = validateClaims({ ...valid, aud: "other" }, baseConfig, issuer, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("AUDIENCE_MISMATCH");
  });

  test("tid not in allowlist", () => {
    const r = validateClaims({ ...valid, tid: "other-tenant" }, baseConfig, issuer, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TENANT_NOT_ALLOWED");
  });

  test("wildcard tenant accepts any tid", () => {
    const r = validateClaims(
      { ...valid, tid: "anything" },
      { ...baseConfig, tenantAllowlist: ["*"] },
      issuer,
      now,
    );
    expect(r.ok).toBe(true);
  });

  test("iss mismatch", () => {
    const r = validateClaims({ ...valid, iss: "https://wrong/" }, baseConfig, issuer, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_JWT");
  });

  test("expired beyond skew", () => {
    const r = validateClaims(
      { ...valid, exp: Math.floor(now / 1000) - 120 },
      baseConfig,
      issuer,
      now,
    );
    expect(r.ok).toBe(false);
  });

  test("nbf in the future beyond skew", () => {
    const r = validateClaims(
      { ...valid, nbf: Math.floor(now / 1000) + 120 },
      baseConfig,
      issuer,
      now,
    );
    expect(r.ok).toBe(false);
  });

  test("missing exp/nbf rejected", () => {
    const r = validateClaims(
      { aud: "app-1", tid: "tenant-1", iss: issuer },
      baseConfig,
      issuer,
      now,
    );
    expect(r.ok).toBe(false);
  });
});

describe("createTokenVerifier (DI path)", () => {
  test("rejects missing bearer header", async () => {
    const v = createTokenVerifier(baseConfig, {
      verifyToken: async () => ({}),
      mintAppToken: async () => "tok",
    });
    const r = await v.verify("", { serviceUrl: "https://smba.trafficmanager.net/" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_JWT");
  });

  test("rejects malformed bearer header", async () => {
    const v = createTokenVerifier(baseConfig, {
      verifyToken: async () => ({}),
      mintAppToken: async () => "tok",
    });
    const r = await v.verify("Token abc", { serviceUrl: "https://smba.trafficmanager.net/" });
    expect(r.ok).toBe(false);
  });

  test("propagates jwtVerify failure as INVALID_JWT", async () => {
    const v = createTokenVerifier(baseConfig, {
      mintAppToken: async () => "tok",
      verifyToken: async () => {
        throw new Error("bad signature");
      },
    });
    const r = await v.verify("Bearer xxx", { serviceUrl: "https://smba.trafficmanager.net/" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_JWT");
  });

  test("full success path with mocked verifyToken", async () => {
    const now = 1_700_000_000_000;
    const v = createTokenVerifier(baseConfig, {
      clock: () => now,
      mintAppToken: async () => "tok",
      verifyToken: async () => ({
        aud: "app-1",
        tid: "tenant-1",
        iss: "https://api.botframework.com",
        exp: Math.floor(now / 1000) + 3600,
        nbf: Math.floor(now / 1000) - 60,
      }),
    });
    const r = await v.verify("Bearer xxx", { serviceUrl: "https://smba.trafficmanager.net/" });
    expect(r.ok).toBe(true);
  });

  test("rejects valid JWT with disallowed serviceUrl", async () => {
    const now = 1_700_000_000_000;
    const v = createTokenVerifier(baseConfig, {
      clock: () => now,
      mintAppToken: async () => "tok",
      verifyToken: async () => ({
        aud: "app-1",
        tid: "tenant-1",
        iss: "https://api.botframework.com",
        exp: Math.floor(now / 1000) + 3600,
        nbf: Math.floor(now / 1000) - 60,
      }),
    });
    const r = await v.verify("Bearer xxx", { serviceUrl: "https://attacker.test/" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SERVICE_URL_NOT_ALLOWED");
  });

  test("appToken delegates to the injected mintAppToken", async () => {
    const v = createTokenVerifier(baseConfig, {
      verifyToken: async () => ({}),
      mintAppToken: async () => "minted-bot-framework-token",
    });
    expect(await v.appToken()).toBe("minted-bot-framework-token");
  });

  test("createTokenVerifier(config) without options throws explicit INVALID_CONFIG", () => {
    // Regression: previous behaviour crashed on `options.clock`
    // dereference when called without the second argument (e.g. from
    // JS or older binding code following a misread of the docs as
    // accepting optional options). The function now hard-fails with
    // an explicit INVALID_CONFIG error naming the missing dependency.
    expect(() =>
      // @ts-expect-error: deliberately omit required options to assert the runtime guard
      createTokenVerifier(baseConfig),
    ).toThrow(/INVALID_CONFIG.*mintAppToken/);
  });
});
