/**
 * Pipeline strategy — stat-based vs LLM pipeline auto-selected by config.
 */

import type { AceConfig } from "./config.js";
import { createDefaultConsolidator } from "./consolidator.js";
import { applyOperations } from "./curator.js";
import { estimateStructuredTokens } from "./playbook.js";
import { computeCurationScore } from "./scoring.js";
import { curateTrajectorySummary } from "./stats-aggregator.js";
import type { TrajectoryBuffer } from "./trajectory-buffer.js";
import type { StructuredPlaybook, TrajectoryEntry } from "./types.js";

const DEFAULT_MIN_CURATION_SCORE = 0.1;
const DEFAULT_RECENCY_DECAY_LAMBDA = 0.01;
const DEFAULT_PLAYBOOK_TOKEN_BUDGET = 2000;

/** Pipeline interface for end-of-session consolidation. */
export interface ConsolidationPipeline {
  readonly consolidate: (
    entries: readonly TrajectoryEntry[],
    sessionId: string,
    sessionCount: number,
    clock: () => number,
    buffer: TrajectoryBuffer,
  ) => Promise<void>;
}

/** Creates the stat-based pipeline (original behavior). */
export function createStatPipeline(config: AceConfig): ConsolidationPipeline {
  return {
    async consolidate(_entries, _sessionId, sessionCount, clock, buffer): Promise<void> {
      const stats = buffer.getStats();
      const scorer = config.scorer ?? computeCurationScore;
      const candidates = curateTrajectorySummary(stats, sessionCount, {
        scorer,
        minScore: config.minCurationScore ?? DEFAULT_MIN_CURATION_SCORE,
        nowMs: clock(),
        lambda: config.recencyDecayLambda ?? DEFAULT_RECENCY_DECAY_LAMBDA,
      });

      if (candidates.length > 0) {
        config.onCurate?.(candidates);

        const consolidate = config.consolidate ?? createDefaultConsolidator({ clock });
        const existing = await config.playbookStore.list();
        const updated = consolidate(candidates, existing);

        await Promise.all(updated.map((pb) => config.playbookStore.save(pb)));
      }
    },
  };
}

/** Creates the LLM-powered pipeline (reflector → curator → apply). */
export function createLlmPipeline(config: AceConfig): ConsolidationPipeline {
  if (
    config.reflector === undefined ||
    config.curator === undefined ||
    config.structuredPlaybookStore === undefined
  ) {
    throw new Error(
      "ACE: createLlmPipeline requires reflector, curator, and structuredPlaybookStore in config",
    );
  }
  const reflector = config.reflector;
  const curator = config.curator;
  const store = config.structuredPlaybookStore;
  const tokenBudget = config.playbookTokenBudget ?? DEFAULT_PLAYBOOK_TOKEN_BUDGET;
  const tokenizer =
    config.tokenEstimator !== undefined
      ? (text: string): number => config.tokenEstimator?.estimateText(text) as number
      : undefined;

  return {
    async consolidate(entries, sessionId, _sessionCount, clock): Promise<void> {
      // Load or create structured playbook for this session
      const playbookId = `ace:structured:${sessionId}`;
      // let: fetched from store, may be replaced with new empty playbook
      let playbook = await store.get(playbookId);
      if (playbook === undefined) {
        playbook = {
          id: playbookId,
          title: `Session ${sessionId} Playbook`,
          sections: [
            { name: "Strategy", slug: "str", bullets: [] },
            { name: "Error Handling", slug: "err", bullets: [] },
            { name: "Tool Usage", slug: "tool", bullets: [] },
          ],
          tags: [],
          source: "curated",
          createdAt: clock(),
          updatedAt: clock(),
          sessionCount: 0,
        };
      }

      // Determine overall outcome from entries
      const outcome = computeOutcome(entries);

      // Collect cited bullet IDs from trajectory
      const citedBulletIds = entries.flatMap((e) => e.bulletIds ?? []);

      // Reflect on trajectory
      const reflection = await reflector.analyze({
        trajectory: entries,
        citedBulletIds,
        outcome,
        playbook,
      });

      // Curate delta operations
      const ops = await curator.curate({
        playbook,
        reflection,
        tokenBudget,
      });

      // Apply bullet credit assignment from reflector
      const taggedPlaybook = applyBulletTags(playbook, reflection.bulletTags, clock);

      // Apply delta operations
      const updated = applyOperations(taggedPlaybook, ops, tokenBudget, clock, tokenizer);

      // Persist
      const final: StructuredPlaybook = {
        ...updated,
        sessionCount: updated.sessionCount + 1,
      };
      await store.save(final);
    },
  };
}

function computeOutcome(entries: readonly TrajectoryEntry[]): "success" | "failure" | "mixed" {
  if (entries.length === 0) return "mixed";
  const hasSuccess = entries.some((e) => e.outcome === "success");
  const hasFailure = entries.some((e) => e.outcome === "failure");
  if (hasSuccess && hasFailure) return "mixed";
  if (hasSuccess) return "success";
  return "failure";
}

function applyBulletTags(
  playbook: StructuredPlaybook,
  tags: readonly { readonly id: string; readonly tag: "helpful" | "harmful" | "neutral" }[],
  clock: () => number,
): StructuredPlaybook {
  if (tags.length === 0) return playbook;

  const tagMap = new Map(tags.map((t) => [t.id, t.tag]));
  const now = clock();

  const sections = playbook.sections.map((section) => ({
    ...section,
    bullets: section.bullets.map((bullet) => {
      const tag = tagMap.get(bullet.id);
      if (tag === undefined || tag === "neutral") return bullet;
      return {
        ...bullet,
        [tag === "helpful" ? "helpful" : "harmful"]:
          bullet[tag === "helpful" ? "helpful" : "harmful"] + 1,
        updatedAt: now,
      };
    }),
  }));

  return { ...playbook, sections };
}

/** Determine if the LLM pipeline should be used based on config. */
export function isLlmPipelineEnabled(config: AceConfig): boolean {
  return (
    config.reflector !== undefined &&
    config.curator !== undefined &&
    config.structuredPlaybookStore !== undefined
  );
}

/** Estimate structured playbook tokens using configured or default tokenizer. */
export function estimatePlaybookTokens(playbook: StructuredPlaybook, config: AceConfig): number {
  const tokenizer =
    config.tokenEstimator !== undefined
      ? (text: string): number => config.tokenEstimator?.estimateText(text) as number
      : undefined;
  return estimateStructuredTokens(playbook, tokenizer);
}
