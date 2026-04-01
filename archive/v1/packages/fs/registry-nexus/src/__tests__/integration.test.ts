/**
 * Integration test for @koi/registry-nexus against a real Nexus server.
 *
 * Skipped unless NEXUS_URL and NEXUS_API_KEY environment variables are set.
 * To run: NEXUS_URL=https://... NEXUS_API_KEY=sk-... bun test packages/registry-nexus/src/__tests__/integration.test.ts
 */

import { describe, test } from "bun:test";
import { runAgentRegistryContractTests } from "@koi/test-utils";
import { createNexusRegistry } from "../nexus-registry.js";

const NEXUS_URL = process.env.NEXUS_URL;
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;

if (NEXUS_URL !== undefined && NEXUS_API_KEY !== undefined) {
  describe("Nexus integration", () => {
    runAgentRegistryContractTests(async () =>
      createNexusRegistry({
        baseUrl: NEXUS_URL,
        apiKey: NEXUS_API_KEY,
        pollIntervalMs: 0,
        timeoutMs: 30_000,
      }),
    );
  });
} else {
  describe("Nexus integration (skipped — NEXUS_URL not set)", () => {
    test.skip("requires NEXUS_URL and NEXUS_API_KEY env vars", () => {});
  });
}
