import { describe, expect, test } from "bun:test";
import { createNonceStore } from "./nonce.js";

describe("createNonceStore", () => {
  test("first sighting accepted, second rejected", () => {
    const store = createNonceStore({ perTenantCapacity: 100, maxTenants: 100 });
    expect(store.checkAndInsert("ch", "t1", "n1")).toBe(true);
    expect(store.checkAndInsert("ch", "t1", "n1")).toBe(false);
  });

  test("nonces are scoped per tenant", () => {
    const store = createNonceStore({ perTenantCapacity: 100, maxTenants: 100 });
    store.checkAndInsert("ch", "t1", "n1");
    expect(store.checkAndInsert("ch", "t2", "n1")).toBe(true);
  });

  test("noisy tenant cannot evict another tenant's nonces (per-tenant capacity)", () => {
    const store = createNonceStore({ perTenantCapacity: 10, maxTenants: 100 });
    store.checkAndInsert("ch", "victim", "v");
    for (let i = 0; i < 50; i++) store.checkAndInsert("ch", "noisy", `n${i}`);
    expect(store.checkAndInsert("ch", "victim", "v")).toBe(false);
  });

  test("tenant slice count is capped", () => {
    const store = createNonceStore({ perTenantCapacity: 5, maxTenants: 3 });
    for (let i = 0; i < 5; i++) store.checkAndInsert("ch", `t${i}`, "n");
    expect(store.tenantCount("ch")).toBeLessThanOrEqual(3);
  });
});
