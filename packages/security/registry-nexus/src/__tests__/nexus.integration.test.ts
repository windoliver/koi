/**
 * Real-Nexus integration test.
 *
 * Skipped unless `KOI_E2E_NEXUS=1` is set in the environment, because it
 * needs a live Nexus admin endpoint (default `http://localhost:3100`).
 * Override the URL with `KOI_NEXUS_URL`.
 *
 * Run locally before merging substantive registry changes:
 *   KOI_E2E_NEXUS=1 bun test packages/security/registry-nexus/src/__tests__/nexus.integration.test.ts
 */

import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import { createHttpTransport } from "@koi/nexus-client";
import { createNexusRegistry } from "../nexus-registry.js";

const RUN = process.env.KOI_E2E_NEXUS === "1";
const NEXUS_URL = process.env.KOI_NEXUS_URL ?? "http://localhost:3100";
const d = RUN ? describe : describe.skip;

d("registry-nexus — real Nexus integration", () => {
  test("registers, transitions, and deregisters an agent end-to-end", async () => {
    const transport = createHttpTransport({ url: NEXUS_URL });
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });

    // Use a unique id to avoid colliding with leftovers from prior runs.
    const id = agentId(`e2e-reg-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`);
    try {
      const registered = await registry.register({
        agentId: id,
        status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "worker",
        metadata: { e2e: true },
        registeredAt: Date.now(),
        priority: 10,
      });
      // #2: created phase preserved (mapNexusAgentToEntry trusts koi:status
      // because it round-trips through CONNECTED).
      expect(registered.status.phase).toBe("created");

      // created → running transition fires the startup event ChildHandle
      // listens for. With the prior canonicalization bug this would have
      // been a no-op.
      const ranResult = await registry.transition(id, "running", registered.status.generation, {
        kind: "assembly_complete",
      });
      expect(ranResult.ok).toBe(true);
      if (ranResult.ok) expect(ranResult.value.status.phase).toBe("running");

      const looked = await registry.lookup(id);
      expect(looked?.status.phase).toBe("running");
    } finally {
      try {
        await registry.deregister(id);
      } catch {
        // best-effort cleanup
      }
      await registry[Symbol.asyncDispose]();
      transport.close();
    }
  });

  test("reserved-key injection via patch is rejected", async () => {
    const transport = createHttpTransport({ url: NEXUS_URL });
    const registry = await createNexusRegistry({ transport, pollIntervalMs: 0 });

    const id = agentId(`e2e-reserved-${String(Date.now())}`);
    try {
      await registry.register({
        agentId: id,
        status: { phase: "running", generation: 0, conditions: [], lastTransitionAt: Date.now() },
        agentType: "worker",
        metadata: {},
        registeredAt: Date.now(),
        priority: 10,
      });
      const result = await registry.patch(id, {
        metadata: { "koi:terminated": true },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("VALIDATION");
    } finally {
      try {
        await registry.deregister(id);
      } catch {
        // best-effort cleanup
      }
      await registry[Symbol.asyncDispose]();
      transport.close();
    }
  });
});
