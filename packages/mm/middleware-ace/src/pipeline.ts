/**
 * Pipeline strategy — stat-based vs LLM pipeline auto-selected by config.
 */

import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
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
const DEFAULT_MAX_REFLECTOR_TOKENS = 4000;
const DEFAULT_RICH_TRAJECTORY_RETENTION_DAYS = 30;
const MS_PER_DAY = 86_400_000;

/** Create a tokenizer function from AceConfig, normalizing sync/async. */
export function createTokenizerFn(
  config: AceConfig,
): ((text: string) => number | Promise<number>) | undefined {
  if (config.tokenEstimator === undefined) return undefined;
  const estimator = config.tokenEstimator;
  return async (text: string): Promise<number> => {
    const result = estimator.estimateText(text);
    return (await result) ?? 0;
  };
}

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
  const tokenizer = createTokenizerFn(config);
  const maxReflectorTokens = config.maxReflectorTokens ?? DEFAULT_MAX_REFLECTOR_TOKENS;

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

      // Fetch rich trajectory — prefer ATIF store with delta watermark
      const richTrajectory = await fetchRichTrajectoryForReflection(
        config,
        sessionId,
        playbook,
        maxReflectorTokens,
      );

      // Legacy: persist to RichTrajectoryStore if configured (no ATIF store)
      if (config.atifStore === undefined && config.richTrajectoryStore !== undefined) {
        const fullRichTrajectory = await fetchFullRichTrajectory(config, sessionId);
        if (fullRichTrajectory !== undefined && fullRichTrajectory.length > 0) {
          await config.richTrajectoryStore.append(sessionId, fullRichTrajectory);
          const retentionDays =
            config.richTrajectoryRetentionDays ?? DEFAULT_RICH_TRAJECTORY_RETENTION_DAYS;
          const cutoff = clock() - retentionDays * MS_PER_DAY;
          await config.richTrajectoryStore.prune(cutoff);
        }
      }

      // Reflect on trajectory (with compressed rich data if available)
      const reflection = await reflector.analyze({
        trajectory: entries,
        ...(richTrajectory !== undefined ? { richTrajectory } : {}),
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
      const updated = await applyOperations(taggedPlaybook, ops, tokenBudget, clock, tokenizer);

      // Update watermark to highest stepIndex in the delta
      const maxStepIndex =
        richTrajectory !== undefined && richTrajectory.length > 0
          ? Math.max(...richTrajectory.map((s) => s.stepIndex))
          : playbook.lastReflectedStepIndex;

      // Persist
      const final: StructuredPlaybook = {
        ...updated,
        sessionCount: updated.sessionCount + 1,
        ...(maxStepIndex !== undefined ? { lastReflectedStepIndex: maxStepIndex } : {}),
      };
      await store.save(final);

      // Signal pipeline completion
      config.onLlmPipelineComplete?.(sessionId);
    },
  };
}

/**
 * Fetch rich trajectory for reflector input, using delta watermark when ATIF store is available.
 *
 * When ATIF store is configured:
 *   - Reads only steps after the playbook's lastReflectedStepIndex (delta)
 *   - Falls back to full document if watermark is corrupted (> max step index)
 *
 * When only richTrajectorySource is configured (legacy):
 *   - Fetches full trajectory and compresses for reflector prompt
 */
async function fetchRichTrajectoryForReflection(
  config: AceConfig,
  sessionId: string,
  playbook: StructuredPlaybook,
  maxReflectorTokens: number,
): Promise<readonly RichTrajectoryStep[] | undefined> {
  // Prefer ATIF store with delta watermark
  if (config.atifStore !== undefined) {
    const watermark = playbook.lastReflectedStepIndex ?? -1;
    const delta = await config.atifStore.getStepRange(
      sessionId,
      watermark + 1,
      Number.MAX_SAFE_INTEGER,
    );

    // Corruption guard: if watermark is beyond what exists, read full document
    if (delta.length === 0 && watermark > 0) {
      const full = await config.atifStore.getDocument(sessionId);
      if (full.length > 0 && watermark > Math.max(...full.map((s) => s.stepIndex))) {
        // Watermark is corrupted — reset by reading everything
        return compressRichTrajectory(full, maxReflectorTokens);
      }
      // Genuinely no new steps — return empty
      return delta.length > 0 ? compressRichTrajectory(delta, maxReflectorTokens) : undefined;
    }

    return delta.length > 0 ? compressRichTrajectory(delta, maxReflectorTokens) : undefined;
  }

  // Legacy path: richTrajectorySource
  const fullRichTrajectory = await fetchFullRichTrajectory(config, sessionId);
  if (fullRichTrajectory !== undefined && fullRichTrajectory.length > 0) {
    return compressRichTrajectory(fullRichTrajectory, maxReflectorTokens);
  }
  return undefined;
}

/** Fetch full (uncompressed) rich trajectory from the configured source. */
async function fetchFullRichTrajectory(
  config: AceConfig,
  sessionId: string,
): Promise<readonly RichTrajectoryStep[] | undefined> {
  if (config.richTrajectorySource === undefined) return undefined;

  const steps = await config.richTrajectorySource(sessionId);
  if (steps.length === 0) return undefined;

  return steps;
}

/**
 * Budget-aware trajectory compression for reflector input.
 *
 * Priority order:
 *  1. Entries with failures or retries (most learning value)
 *  2. Entries with cited bullet IDs (credit assignment)
 *  3. Most recent entries (recency)
 *
 * Tool observation payloads are truncated to stay within budget.
 */
export function compressRichTrajectory(
  steps: readonly RichTrajectoryStep[],
  maxTokens: number,
): readonly RichTrajectoryStep[] {
  if (steps.length === 0) return [];

  // Roughly 4 chars per token
  const maxChars = maxTokens * 4;

  // Sort by priority: failures first, then cited, then recency
  const prioritized = [...steps].sort((a, b) => {
    const aPriority = stepPriority(a);
    const bPriority = stepPriority(b);
    if (aPriority !== bPriority) return bPriority - aPriority;
    // Within same priority, prefer more recent
    return b.timestamp - a.timestamp;
  });

  const result: RichTrajectoryStep[] = [];
  // let: tracks accumulated character count for budget enforcement
  let totalChars = 0;

  for (const step of prioritized) {
    const stepChars = estimateStepChars(step);
    if (totalChars + stepChars > maxChars && result.length > 0) {
      // Try truncating content to fit
      const truncated = truncateStep(step, maxChars - totalChars);
      if (truncated !== undefined) {
        result.push(truncated);
        totalChars += estimateStepChars(truncated);
      }
      break;
    }
    result.push(step);
    totalChars += stepChars;
  }

  // Re-sort by step index for chronological order in prompt
  return result.sort((a, b) => a.stepIndex - b.stepIndex);
}

function stepPriority(step: RichTrajectoryStep): number {
  if (step.outcome === "failure" || step.outcome === "retry") return 3;
  if (step.bulletIds !== undefined && step.bulletIds.length > 0) return 2;
  return 1;
}

function estimateStepChars(step: RichTrajectoryStep): number {
  // let: mutable accumulator for character count
  let chars = 50; // baseline for metadata
  chars += step.request?.text?.length ?? 0;
  chars += step.response?.text?.length ?? 0;
  chars += step.error?.text?.length ?? 0;
  chars += step.reasoningContent?.length ?? 0;
  return chars;
}

const MAX_CONTENT_CHARS = 500;

function truncateStep(step: RichTrajectoryStep, maxChars: number): RichTrajectoryStep | undefined {
  if (maxChars < 100) return undefined; // too small to be useful

  const truncateContent = (
    content: RichTrajectoryStep["request"],
  ): RichTrajectoryStep["request"] => {
    if (content === undefined) return undefined;
    if (content.text === undefined) return content;
    const limit = Math.min(MAX_CONTENT_CHARS, maxChars / 3);
    if (content.text.length <= limit) return content;
    return {
      ...content,
      text: `${content.text.slice(0, limit)}...`,
      truncated: true,
      originalSize: content.originalSize ?? content.text.length,
    };
  };

  const truncatedRequest = truncateContent(step.request);
  const truncatedResponse = truncateContent(step.response);
  const truncatedError = truncateContent(step.error);
  const truncatedReasoning =
    step.reasoningContent !== undefined && step.reasoningContent.length > MAX_CONTENT_CHARS
      ? `${step.reasoningContent.slice(0, MAX_CONTENT_CHARS)}...`
      : step.reasoningContent;

  return {
    ...step,
    ...(truncatedRequest !== undefined ? { request: truncatedRequest } : {}),
    ...(truncatedResponse !== undefined ? { response: truncatedResponse } : {}),
    ...(truncatedError !== undefined ? { error: truncatedError } : {}),
    ...(truncatedReasoning !== undefined ? { reasoningContent: truncatedReasoning } : {}),
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
export function estimatePlaybookTokens(
  playbook: StructuredPlaybook,
  config: AceConfig,
): number | Promise<number> {
  return estimateStructuredTokens(playbook, createTokenizerFn(config));
}
