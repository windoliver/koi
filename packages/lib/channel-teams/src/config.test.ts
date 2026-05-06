import { describe, expect, test } from "bun:test";
import { validateTeamsConfig } from "./config.js";

const baseConfig = {
  appId: "00000000-0000-0000-0000-000000000001",
  appPassword: "secret",
  tenantAllowlist: ["tenant-1"],
  serviceUrlAllowlist: [{ scheme: "https", host: "smba.trafficmanager.net", hostMatch: "exact" }],
};

describe("validateTeamsConfig", () => {
  test("accepts minimal public-cloud config and applies defaults", () => {
    const r = validateTeamsConfig(baseConfig);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.cloud).toBe("public");
    expect(r.value.production).toBe(false);
    expect(r.value.handlerTimeoutMs).toBe(300_000);
    expect(r.value.commitTtlMs).toBe(24 * 60 * 60 * 1000);
  });

  test("rejects empty tenantAllowlist", () => {
    const r = validateTeamsConfig({ ...baseConfig, tenantAllowlist: [] });
    expect(r.ok).toBe(false);
  });

  test("rejects empty serviceUrlAllowlist", () => {
    const r = validateTeamsConfig({ ...baseConfig, serviceUrlAllowlist: [] });
    expect(r.ok).toBe(false);
  });

  test("rejects scheme other than https", () => {
    const r = validateTeamsConfig({
      ...baseConfig,
      serviceUrlAllowlist: [{ scheme: "http", host: "x", hostMatch: "exact" }],
    });
    expect(r.ok).toBe(false);
  });

  test("accepts inline cloud with both issuer and jwksUri", () => {
    const r = validateTeamsConfig({
      ...baseConfig,
      cloud: { issuer: "https://issuer.example.com/", jwksUri: "https://jwks.example.com/keys" },
    });
    expect(r.ok).toBe(true);
  });

  test("rejects inline cloud with only issuer", () => {
    const r = validateTeamsConfig({
      ...baseConfig,
      cloud: { issuer: "https://issuer.example.com/" },
    });
    expect(r.ok).toBe(false);
  });

  test("rejects inline cloud with only jwksUri", () => {
    const r = validateTeamsConfig({
      ...baseConfig,
      cloud: { jwksUri: "https://jwks.example.com/keys" },
    });
    expect(r.ok).toBe(false);
  });

  test("accepts gov cloud profile", () => {
    const r = validateTeamsConfig({ ...baseConfig, cloud: "gov" });
    expect(r.ok).toBe(true);
  });

  test("accepts wildcard tenant", () => {
    const r = validateTeamsConfig({ ...baseConfig, tenantAllowlist: ["*"] });
    expect(r.ok).toBe(true);
  });

  test("rejects missing appId", () => {
    const r = validateTeamsConfig({ ...baseConfig, appId: undefined });
    expect(r.ok).toBe(false);
  });
});
