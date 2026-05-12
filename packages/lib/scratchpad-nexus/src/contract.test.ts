/**
 * Layer 2 contract test — runs the full ScratchpadComponent conformance suite
 * against a *real* Nexus server reachable at `NEXUS_URL`.
 *
 * Skipped by default: CI does not have a Nexus instance, and the in-process
 * fake server in `conformance.test.ts` already covers adapter logic. This
 * test catches the things mocks cannot:
 *   - real JSON serialization round-trips (Date ↔ ISO string, branded IDs)
 *   - real cursor opacity from the server's pagination implementation
 *   - real CAS races under server-side concurrency
 *   - permission/auth boundaries enforced by Nexus
 *
 * To run locally:
 *   NEXUS_URL=https://nexus.dev.koi.internal NEXUS_API_KEY=... bun test contract
 */
import { describe, test } from "bun:test";
import { agentGroupId, agentId } from "@koi/core";
import { createHttpTransport } from "@koi/nexus-client";
import { describeScratchpadConformance } from "@koi/scratchpad-conformance";
import { createNexusScratchpad } from "./scratchpad.js";

const NEXUS_URL = process.env.NEXUS_URL;
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;

if (NEXUS_URL === undefined || NEXUS_URL.length === 0) {
  describe.skip("ScratchpadComponent contract: real Nexus server (NEXUS_URL unset)", () => {
    test("skipped — set NEXUS_URL to run", () => {});
  });
} else {
  let counter = 0;
  describeScratchpadConformance("createNexusScratchpad ↔ real Nexus", async () => {
    const transport = createHttpTransport({
      url: NEXUS_URL,
      ...(NEXUS_API_KEY !== undefined && NEXUS_API_KEY.length > 0 ? { apiKey: NEXUS_API_KEY } : {}),
    });
    return createNexusScratchpad({
      groupId: agentGroupId(`contract-${Date.now()}-${++counter}`),
      authorId: agentId(`contract-author-${counter}`),
      transport,
      pollIntervalMs: 250,
    });
  });
}
