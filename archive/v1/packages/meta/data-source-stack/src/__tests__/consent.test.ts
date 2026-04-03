import { describe, expect, test } from "bun:test";
import type { ConsentCallbacks } from "@koi/data-source-discovery";
import { createDataSourceStack } from "../data-source-stack.js";

const MANIFEST_ENTRIES = [
  { name: "orders-db", protocol: "postgres", description: "Orders" },
  { name: "users-api", protocol: "http", description: "Users API" },
] as const;

describe("createDataSourceStack consent", () => {
  test("approve_all includes all sources", async () => {
    const consent: ConsentCallbacks = {
      approve: async () => true,
      presentBatch: async () => ({ kind: "approve_all" }),
    };

    const bundle = await createDataSourceStack({
      manifestEntries: [...MANIFEST_ENTRIES],
      env: { DATABASE_URL: "postgres://localhost/test" },
      consent,
      discoveryConfig: { enableEnvProbe: false, enableMcpProbe: false },
    });

    expect(bundle.discoveredSources).toHaveLength(2);
    expect(bundle.discoveredSources.map((s) => s.name)).toEqual(["orders-db", "users-api"]);
  });

  test("deny_all returns empty output with no tools", async () => {
    const consent: ConsentCallbacks = {
      approve: async () => true,
      presentBatch: async () => ({ kind: "deny_all" }),
    };

    const bundle = await createDataSourceStack({
      manifestEntries: [...MANIFEST_ENTRIES],
      env: { DATABASE_URL: "postgres://localhost/test" },
      consent,
      discoveryConfig: { enableEnvProbe: false, enableMcpProbe: false },
    });

    expect(bundle.discoveredSources).toHaveLength(0);
    expect(bundle.tools).toHaveLength(0);
    expect(bundle.skillComponents).toHaveLength(0);
  });

  test("select filters to approved names only", async () => {
    const consent: ConsentCallbacks = {
      approve: async () => true,
      presentBatch: async () => ({
        kind: "select",
        approved: ["orders-db"],
      }),
    };

    const bundle = await createDataSourceStack({
      manifestEntries: [...MANIFEST_ENTRIES],
      env: { DATABASE_URL: "postgres://localhost/test" },
      consent,
      discoveryConfig: { enableEnvProbe: false, enableMcpProbe: false },
    });

    expect(bundle.discoveredSources).toHaveLength(1);
    expect(bundle.discoveredSources[0]?.name).toBe("orders-db");
  });

  test("empty discovery never calls consent", async () => {
    let consentCalled = false;
    const consent: ConsentCallbacks = {
      approve: async () => {
        consentCalled = true;
        return true;
      },
      presentBatch: async () => {
        consentCalled = true;
        return { kind: "approve_all" };
      },
    };

    const bundle = await createDataSourceStack({
      env: {},
      consent,
      discoveryConfig: { enableEnvProbe: false, enableMcpProbe: false },
    });

    expect(bundle.discoveredSources).toHaveLength(0);
    expect(consentCalled).toBe(false);
  });

  test("no consent callback passes all sources through (backward compat)", async () => {
    const bundle = await createDataSourceStack({
      manifestEntries: [...MANIFEST_ENTRIES],
      env: { DATABASE_URL: "postgres://localhost/test" },
      discoveryConfig: { enableEnvProbe: false, enableMcpProbe: false },
    });

    expect(bundle.discoveredSources).toHaveLength(2);
  });
});
