import { describe, expect, it } from "bun:test";

import type { VercelAdapterConfig } from "./types.js";
import { validateVercelAdapterConfig } from "./validate.js";

const base: VercelAdapterConfig = {
  dedupeKvUrl: "https://kv.example",
  dedupeKvToken: "tok",
  ownerId: "acme",
};

describe("validateVercelAdapterConfig", () => {
  it("accepts a minimal valid config", () => {
    const r = validateVercelAdapterConfig(base);
    expect(r.ok).toBe(true);
  });

  it("rejects missing dedupeKvUrl", () => {
    const r = validateVercelAdapterConfig({ ...base, dedupeKvUrl: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects missing dedupeKvToken", () => {
    const r = validateVercelAdapterConfig({ ...base, dedupeKvToken: "" });
    expect(r.ok).toBe(false);
  });

  it('rejects ownerId === "default"', () => {
    const r = validateVercelAdapterConfig({ ...base, ownerId: "default" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_CONFIG");
  });

  it("rejects empty ownerId", () => {
    const r = validateVercelAdapterConfig({ ...base, ownerId: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown integrityVerification mode", () => {
    const r = validateVercelAdapterConfig({
      ...base,
      integrityVerification: "off" as never,
    });
    expect(r.ok).toBe(false);
  });

  it("accepts the three documented modes", () => {
    for (const mode of ["cached", "strict", "async"] as const) {
      const r = validateVercelAdapterConfig({ ...base, integrityVerification: mode });
      expect(r.ok).toBe(true);
    }
  });
});
