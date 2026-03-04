/**
 * Run the reusable TaskStore contract tests against NexusTaskStore.
 */

import { createNexusClient } from "@koi/nexus-client";
import { createFakeNexusFetch, runTaskStoreContractTests } from "@koi/test-utils";
import { createNexusTaskStore } from "./nexus-task-store.js";

runTaskStoreContractTests(() => {
  // Fresh fake per test to avoid shared state
  const fakeFetch = createFakeNexusFetch();
  const client = createNexusClient({
    baseUrl: "http://fake-nexus",
    apiKey: "test-key",
    fetch: fakeFetch,
  });
  return createNexusTaskStore(client);
});
