import { describe, expect, it } from "bun:test";

import type { SandboxProfile } from "@koi/core";

import { createCloudflareAdapter } from "./adapter.js";
import type { CloudflareAdapterConfig } from "./types.js";

const validConfig: CloudflareAdapterConfig = {
  accountId: "acct",
  apiToken: "tok",
  ownerId: "acme",
  dedupeDurableObjectNamespaceId: "ns-1",
};

const profile: SandboxProfile = {
  filesystem: { defaultReadAccess: "closed" },
  network: { allow: false },
  resources: { timeoutMs: 5000 },
};

describe("createCloudflareAdapter", () => {
  it("returns a configured adapter for valid config", () => {
    const r = createCloudflareAdapter(validConfig);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe("cloudflare");
    expect(r.value.version).toBeDefined();
  });

  it("propagates config-validation errors", () => {
    const r = createCloudflareAdapter({ ...validConfig, ownerId: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects workloadClass other than 'A' at create()", async () => {
    const adapter = createCloudflareAdapter(validConfig);
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) return;
    const result = await adapter.value.create({
      code: "export default {}",
      profile,
      workloadClass: "B" as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.context?.subcode).toBe("WORKLOAD_CLASS_NOT_SUPPORTED");
  });

  it("rejects empty `code`", async () => {
    const adapter = createCloudflareAdapter(validConfig);
    if (!adapter.ok) throw new Error("setup");
    const result = await adapter.value.create({ code: "", profile, workloadClass: "A" });
    expect(result.ok).toBe(false);
  });

  it("returns UNAVAILABLE for valid create() in this skeleton commit", async () => {
    const adapter = createCloudflareAdapter(validConfig);
    if (!adapter.ok) throw new Error("setup");
    const result = await adapter.value.create({
      code: "export default { fetch() { return new Response('ok'); } }",
      profile,
      workloadClass: "A",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNAVAILABLE");
    expect(result.error.context?.subcode).toBe("ADAPTER_NOT_IMPLEMENTED");
  });
});
