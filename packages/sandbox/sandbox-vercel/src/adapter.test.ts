import { describe, expect, it } from "bun:test";

import { createVercelAdapter, VERCEL_ADAPTER_VERSION } from "./adapter.js";
import type { VercelAdapterConfig } from "./types.js";

const base: VercelAdapterConfig = {
  dedupeKvUrl: "https://kv.example",
  dedupeKvToken: "tok",
  ownerId: "acme",
};

describe("createVercelAdapter", () => {
  it("returns an adapter for a valid config", () => {
    const r = createVercelAdapter(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe("vercel");
    expect(r.value.version).toBe(VERCEL_ADAPTER_VERSION);
  });

  it("propagates validation errors", () => {
    const r = createVercelAdapter({ ...base, ownerId: "default" });
    expect(r.ok).toBe(false);
  });

  it("rejects non-A workloadClass on create()", async () => {
    const r = createVercelAdapter(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const created = await r.value.create({
      workloadClass: "B" as never,
      code: "export default {}",
      operationId: "op-1",
    } as never);
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe("INVALID_CONFIG");
    expect(created.error.context?.subcode).toBe("WORKLOAD_CLASS_NOT_SUPPORTED");
  });

  it("returns UNAVAILABLE/ADAPTER_NOT_IMPLEMENTED for valid create() in v1", async () => {
    const r = createVercelAdapter(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const created = await r.value.create({
      workloadClass: "A",
      code: "export default { fetch() { return new Response() } }",
      operationId: "op-1",
    } as never);
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe("UNAVAILABLE");
    expect(created.error.context?.subcode).toBe("ADAPTER_NOT_IMPLEMENTED");
  });

  it("rejects empty code", async () => {
    const r = createVercelAdapter(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const created = await r.value.create({
      workloadClass: "A",
      code: "",
      operationId: "op-1",
    } as never);
    expect(created.ok).toBe(false);
  });
});
