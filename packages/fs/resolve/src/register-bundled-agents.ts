/**
 * Auto-registration of bundled agents into ForgeStore.
 *
 * Accepts pre-built AgentArtifact instances and saves them into
 * the ForgeStore. Idempotent: agents whose ID already exists are
 * skipped. Partial-failure tolerant: save errors are collected.
 *
 * Follows the same pattern as registerCompanionSkills.
 */

import type { AgentArtifact, ForgeStore, KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Summary of bundled agent registration. */
export interface BundledAgentRegistrationResult {
  readonly registered: number;
  readonly skipped: number;
  readonly errors: readonly string[];
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers pre-built AgentArtifacts into a ForgeStore.
 *
 * Idempotent: agents whose content-addressed ID already exists are skipped.
 * Partial-failure tolerant: save errors are collected, not thrown.
 */
export async function registerBundledAgents(
  agents: readonly AgentArtifact[],
  forgeStore: ForgeStore,
): Promise<Result<BundledAgentRegistrationResult, KoiError>> {
  // let justified: mutable counters for sequential accumulation
  let registered = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const agent of agents) {
    // Idempotency check — treat exists() failure as "not exists"
    const existsResult = await forgeStore.exists(agent.id);
    if (existsResult.ok && existsResult.value) {
      skipped += 1;
      continue;
    }

    const saveResult = await forgeStore.save(agent);
    if (!saveResult.ok) {
      errors.push(`Failed to save bundled agent "${agent.name}": ${saveResult.error.message}`);
      continue;
    }

    registered += 1;
  }

  return {
    ok: true,
    value: { registered, skipped, errors },
  };
}
