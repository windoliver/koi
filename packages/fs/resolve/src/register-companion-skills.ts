/**
 * Auto-registration of companion skills from BrickDescriptors into ForgeStore.
 *
 * Two-phase pipeline: discoverDescriptors() remains pure, then
 * registerCompanionSkills() writes skills to ForgeStore as a separate step.
 */

import type {
  BrickId,
  CompanionSkillDefinition,
  ForgeProvenance,
  ForgeStore,
  KoiError,
  Result,
  SkillArtifact,
} from "@koi/core";
import { computeBrickId } from "@koi/hash";

import type { BrickDescriptor } from "./types.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Summary of companion skill registration. */
export interface CompanionSkillRegistrationResult {
  readonly registered: number;
  readonly skipped: number;
  readonly errors: readonly string[];
}

// ---------------------------------------------------------------------------
// Artifact factory
// ---------------------------------------------------------------------------

/**
 * Creates a SkillArtifact from a CompanionSkillDefinition + descriptor metadata.
 *
 * Content-addressed via computeBrickId("skill", skill.content).
 * Trust tier is "promoted" because package-shipped skills are pre-verified.
 */
export function createCompanionSkillArtifact(
  skill: CompanionSkillDefinition,
  descriptorName: string,
  descriptorKind: string,
): SkillArtifact {
  const id: BrickId = computeBrickId("skill", skill.content);
  const contentHash = id.slice("sha256:".length);

  const provenance: ForgeProvenance = {
    source: { origin: "bundled", bundleName: descriptorName, bundleVersion: "0.1.0" },
    buildDefinition: {
      buildType: "companion-skill",
      externalParameters: { descriptorKind },
    },
    builder: { id: "koi:resolve" },
    metadata: {
      invocationId: "",
      startedAt: 0,
      finishedAt: 0,
      sessionId: "",
      agentId: "",
      depth: 0,
    },
    verification: {
      passed: true,
      finalTrustTier: "promoted",
      totalDurationMs: 0,
      stageResults: [],
    },
    classification: "public",
    contentMarkers: [],
    contentHash,
  };

  const baseTags: readonly string[] = skill.tags ?? [];

  return {
    id,
    kind: "skill",
    name: skill.name,
    description: skill.description,
    content: skill.content,
    scope: "global",
    trustTier: "promoted",
    lifecycle: "active",
    version: "0.1.0",
    tags: [...baseTags, `from:${descriptorName}`, "companion"],
    usageCount: 0,
    provenance,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers all companion skills from descriptors into a ForgeStore.
 *
 * Idempotent: skills whose content-addressed ID already exists are skipped.
 * Partial failure tolerant: save errors are collected, not thrown.
 */
export async function registerCompanionSkills(
  descriptors: readonly BrickDescriptor<unknown>[],
  forgeStore: ForgeStore,
): Promise<Result<CompanionSkillRegistrationResult, KoiError>> {
  // let is justified: mutable counters for sequential accumulation
  let registered = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const descriptor of descriptors) {
    const skills = descriptor.companionSkills;
    if (skills === undefined || skills.length === 0) {
      continue;
    }

    for (const skill of skills) {
      const artifact = createCompanionSkillArtifact(skill, descriptor.name, descriptor.kind);

      // Idempotency check — treat exists() failure as "not exists"
      const existsResult = await forgeStore.exists(artifact.id);
      if (existsResult.ok && existsResult.value) {
        skipped += 1;
        continue;
      }

      const saveResult = await forgeStore.save(artifact);
      if (!saveResult.ok) {
        errors.push(
          `Failed to save companion skill "${skill.name}" from ${descriptor.name}: ${saveResult.error.message}`,
        );
        continue;
      }

      registered += 1;
    }
  }

  return {
    ok: true,
    value: { registered, skipped, errors },
  };
}
