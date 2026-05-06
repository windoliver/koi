import { describe, expect, it } from "bun:test";

import type { CloudflareAdapterConfig } from "./types.js";
import { validateCloudflareAdapterConfig } from "./validate.js";

const base: CloudflareAdapterConfig = {
  accountId: "acct",
  apiToken: "tok",
  ownerId: "acme",
  dedupeDurableObjectNamespaceId: "ns-abc",
};

describe("validateCloudflareAdapterConfig", () => {
  it("accepts a minimal valid config", () => {
    const r = validateCloudflareAdapterConfig(base);
    expect(r.ok).toBe(true);
  });

  it("rejects missing accountId", () => {
    const r = validateCloudflareAdapterConfig({ ...base, accountId: "" });
    expect(r.ok).toBe(false);
  });

  it('rejects ownerId === "default"', () => {
    const r = validateCloudflareAdapterConfig({ ...base, ownerId: "default" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_CONFIG");
  });

  it("rejects unknown integrityVerification mode", () => {
    const r = validateCloudflareAdapterConfig({
      ...base,
      integrityVerification: "off" as never,
    });
    expect(r.ok).toBe(false);
  });

  it("accepts the three documented modes", () => {
    for (const mode of ["cached", "strict", "async"] as const) {
      const r = validateCloudflareAdapterConfig({ ...base, integrityVerification: mode });
      expect(r.ok).toBe(true);
    }
  });
});
