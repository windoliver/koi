/**
 * Run the reusable ScheduleStore contract tests against NexusScheduleStore.
 */

import { createNexusClient } from "@koi/nexus-client";
import { createFakeNexusFetch, runScheduleStoreContractTests } from "@koi/test-utils";
import { createNexusScheduleStore } from "./nexus-schedule-store.js";

runScheduleStoreContractTests(() => {
  // Fresh fake per test to avoid shared state
  const fakeFetch = createFakeNexusFetch();
  const client = createNexusClient({
    baseUrl: "http://fake-nexus",
    apiKey: "test-key",
    fetch: fakeFetch,
  });
  return createNexusScheduleStore(client);
});
