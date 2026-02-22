/**
 * Integration test for NexusArtifactStore against a real Nexus instance.
 *
 * Gated on NEXUS_URL and NEXUS_API_KEY environment variables.
 * Skipped in CI unless Nexus is available.
 */

import { describe } from "bun:test";
import { createNexusArtifactStore } from "../nexus-store.js";
import { runArtifactStoreContractTests } from "./store-contract.js";

const NEXUS_URL = process.env.NEXUS_URL;
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;

(NEXUS_URL && NEXUS_API_KEY ? describe : describe.skip)("NexusArtifactStore integration", () => {
  // Guard already ensures both are defined inside this block
  const url = NEXUS_URL as string;
  const key = NEXUS_API_KEY as string;

  runArtifactStoreContractTests(() =>
    createNexusArtifactStore({
      baseUrl: url,
      apiKey: key,
      basePath: `/artifacts-test-${Date.now()}`,
    }),
  );
});
