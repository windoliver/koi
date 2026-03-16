/**
 * Skill reference provider — progressive disclosure for forged skills.
 *
 * Phase 3B: Instead of dumping full skill content into every context window,
 * this provider offers three disclosure levels:
 * 1. Metadata — name, description, tags (cheapest, always available)
 * 2. Instructions — full SKILL.md content (on demand)
 * 3. Resources — scripts, references, examples (on demand)
 *
 * AgentSkills.io progressive disclosure pattern: metadata → instructions → resources.
 */

import type { BrickSummary, ForgeQuery, ForgeStore, KoiError, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal metadata for skill discovery (level 1: cheapest).
 * Extends BrickSummary — all brick kinds share this lightweight shape.
 */
export type SkillMetadata = BrickSummary;

/** Full skill instructions (level 2: on demand). */
export interface SkillInstructions {
  readonly id: string;
  readonly name: string;
  readonly content: string;
}

/** Skill reference provider — progressive disclosure API. */
export interface SkillReferenceProvider {
  /** List available skill metadata (cheapest query — names + descriptions only). */
  readonly listSkills: () => Promise<Result<readonly SkillMetadata[], KoiError>>;
  /** Get full instructions for a specific skill (on demand). */
  readonly getInstructions: (skillId: string) => Promise<Result<SkillInstructions, KoiError>>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a skill reference provider backed by a ForgeStore.
 *
 * Queries are lazy — listSkills returns metadata only, getInstructions
 * loads the full artifact on demand.
 */
export function createSkillReferenceProvider(store: ForgeStore): SkillReferenceProvider {
  const listSkills = async (): Promise<Result<readonly SkillMetadata[], KoiError>> => {
    const query: ForgeQuery = { kind: "skill" };
    return store.searchSummaries(query);
  };

  const getInstructions = async (skillId: string): Promise<Result<SkillInstructions, KoiError>> => {
    const result = await store.load(skillId as never);
    if (!result.ok) return result;

    const brick = result.value;
    if (brick.kind !== "skill") {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `Brick ${skillId} is a ${brick.kind}, not a skill`,
          retryable: false,
        },
      };
    }

    return {
      ok: true,
      value: {
        id: brick.id,
        name: brick.name,
        content: brick.content,
      },
    };
  };

  return { listSkills, getInstructions };
}
