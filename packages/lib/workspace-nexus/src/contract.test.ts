/**
 * Layer 2 contract test — runs the full WorkspaceBackend conformance suite
 * against a *real* Nexus server reachable at `NEXUS_URL`.
 *
 * Skipped by default: CI does not have a Nexus instance, and the in-process
 * fake server in `conformance.test.ts` already covers adapter logic. This
 * test catches:
 *   - real workspace lifecycle on a remote sandbox provider
 *   - crash-survivor flow: create → terminate → findByAgentId → reuse vs dispose
 *   - real attestation hooks under concurrent verify/attest interleaving
 *   - permission/auth boundaries enforced by Nexus
 *
 * To run locally:
 *   NEXUS_URL=https://nexus.dev.koi.internal NEXUS_API_KEY=... bun test contract
 */
import { describe, test } from "bun:test";
import { createHttpTransport } from "@koi/nexus-client";
import { describeWorkspaceConformance } from "@koi/workspace-conformance";
import { createNexusWorkspaceBackend } from "./backend.js";

const NEXUS_URL = process.env.NEXUS_URL;
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;

if (NEXUS_URL === undefined || NEXUS_URL.length === 0) {
  describe.skip("WorkspaceBackend contract: real Nexus server (NEXUS_URL unset)", () => {
    test("skipped — set NEXUS_URL to run", () => {});
  });
} else {
  describeWorkspaceConformance("createNexusWorkspaceBackend ↔ real Nexus", async () => {
    const transport = createHttpTransport({
      url: NEXUS_URL,
      ...(NEXUS_API_KEY !== undefined && NEXUS_API_KEY.length > 0 ? { apiKey: NEXUS_API_KEY } : {}),
    });
    const backend = await createNexusWorkspaceBackend({ transport });
    return { backend };
  });
}
