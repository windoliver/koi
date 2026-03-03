import { describe } from "bun:test";
import { createFakeNexusFetch } from "./__tests__/fake-nexus-fetch.js";
import { runHandoffStoreContractTests } from "./__tests__/store-contract.js";
import { createNexusHandoffStore } from "./nexus-store.js";

describe("NexusHandoffStore", () => {
  runHandoffStoreContractTests(() =>
    createNexusHandoffStore({
      baseUrl: "http://fake-nexus:2026",
      apiKey: "test-key",
      fetch: createFakeNexusFetch(),
    }),
  );
});
