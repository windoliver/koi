/**
 * Brick optimizer — statistical A/B testing for crystallized bricks.
 *
 * Evaluates whether a crystallized composite brick is better than calling
 * its component tools individually. Uses fitness metrics (success rate,
 * latency, recency) to compute a fitness score and decide whether to
 * keep, deprecate, or flag variant superiority.
 *
 * Depends on @koi/core only (ForgeStore, BrickArtifact, BrickFitnessMetrics).
 */

import type {
  BrickArtifact,
  BrickFitnessMetrics,
  BrickId,
  ForgeStore,
  StoreChangeNotifier,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the brick optimizer. */
export interface OptimizationConfig {
  readonly store: ForgeStore;
  /** Minimum total invocations before evaluation. Default: 20. */
  readonly minSampleSize?: number | undefined;
  /** Minimum improvement threshold to justify the composite. Default: 0.1 (10%). */
  readonly improvementThreshold?: number | undefined;
  /** Time window for recency factor in milliseconds. Default: 604_800_000 (7 days). */
  readonly evaluationWindowMs?: number | undefined;
  /**
   * Minimum invocations with 100% success rate to promote to policy mode.
   * Policy-eligible bricks can short-circuit model calls. Default: 50.
   * Set to Infinity to disable policy promotion.
   */
  readonly minPolicySamples?: number | undefined;
  /** Clock function. Default: Date.now. */
  readonly clock?: (() => number) | undefined;
  /** Optional notifier for cross-agent cache invalidation after deprecation. */
  readonly notifier?: StoreChangeNotifier | undefined;
}

/** Result of evaluating a single brick. */
export interface OptimizationResult {
  readonly brickId: BrickId;
  readonly action:
    | "keep"
    | "deprecate"
    | "variant_better"
    | "insufficient_data"
    | "promote_to_policy";
  readonly fitnessOriginal: number;
  readonly fitnessVariant?: number | undefined;
  readonly reason: string;
}

/** Brick optimizer interface. */
export interface BrickOptimizer {
  /** Evaluate a crystallized brick vs its component tools. */
  readonly evaluate: (brickId: BrickId) => Promise<OptimizationResult>;
  /** Run optimization pass on all eligible bricks. */
  readonly sweep: () => Promise<readonly OptimizationResult[]>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MIN_SAMPLE_SIZE = 20;
const DEFAULT_IMPROVEMENT_THRESHOLD = 0.1;
const DEFAULT_EVALUATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MIN_POLICY_SAMPLES = 50;

// ---------------------------------------------------------------------------
// Pure fitness scoring
// ---------------------------------------------------------------------------

/**
 * Compute a fitness score from brick fitness metrics.
 *
 * Formula: successRate * (1 / avgLatencyMs) * recencyFactor
 *
 * - successRate: successCount / (successCount + errorCount)
 * - avgLatencyMs: average of latency samples (minimum 1ms to avoid division by zero)
 * - recencyFactor: exponential decay based on time since last use
 */
export function computeFitnessScore(
  fitness: BrickFitnessMetrics,
  now: number,
  evaluationWindowMs: number,
): number {
  const total = fitness.successCount + fitness.errorCount;
  if (total === 0) return 0;

  const successRate = fitness.successCount / total;

  // Average latency from samples, minimum 1ms to avoid division by zero
  const avgLatency =
    fitness.latency.samples.length > 0
      ? Math.max(
          1,
          fitness.latency.samples.reduce((sum, s) => sum + s, 0) / fitness.latency.samples.length,
        )
      : 1;

  // Recency factor: exponential decay, halves every evaluationWindow
  const ageMs = Math.max(0, now - fitness.lastUsedAt);
  const recencyFactor = 0.5 ** (ageMs / evaluationWindowMs);

  return successRate * (1 / avgLatency) * recencyFactor;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a brick optimizer that evaluates crystallized composites.
 *
 * The optimizer compares a composite brick's fitness score against the
 * aggregate fitness of its component tools. If the composite is not
 * significantly better, it gets deprecated.
 */
export function createBrickOptimizer(config: OptimizationConfig): BrickOptimizer {
  const minSampleSize = config.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;
  const threshold = config.improvementThreshold ?? DEFAULT_IMPROVEMENT_THRESHOLD;
  const windowMs = config.evaluationWindowMs ?? DEFAULT_EVALUATION_WINDOW_MS;
  const minPolicySamples = config.minPolicySamples ?? DEFAULT_MIN_POLICY_SAMPLES;
  const clock = config.clock ?? Date.now;

  const evaluate = async (brickId: BrickId): Promise<OptimizationResult> => {
    const loadResult = await config.store.load(brickId);
    if (!loadResult.ok) {
      return {
        brickId,
        action: "insufficient_data",
        fitnessOriginal: 0,
        reason: `Brick not found: ${brickId}`,
      };
    }

    const brick = loadResult.value;
    const fitness = brick.fitness;

    // Check if we have enough data
    if (fitness === undefined) {
      return {
        brickId,
        action: "insufficient_data",
        fitnessOriginal: 0,
        reason: "No fitness metrics available",
      };
    }

    const totalInvocations = fitness.successCount + fitness.errorCount;
    if (totalInvocations < minSampleSize) {
      return {
        brickId,
        action: "insufficient_data",
        fitnessOriginal: 0,
        reason: `Insufficient data: ${String(totalInvocations)}/${String(minSampleSize)} invocations`,
      };
    }

    // Check for policy promotion: 100% success over minPolicySamples
    if (
      fitness.errorCount === 0 &&
      totalInvocations >= minPolicySamples &&
      isHarnessSynthesizedBrick(brick)
    ) {
      return {
        brickId,
        action: "promote_to_policy",
        fitnessOriginal: computeFitnessScore(fitness, clock(), windowMs),
        reason: `100% success rate over ${String(totalInvocations)} invocations — eligible for policy mode`,
      };
    }

    const now = clock();
    const compositeFitness = computeFitnessScore(fitness, now, windowMs);

    // Try to load component tools from provenance
    const componentFitness = await computeComponentAggregateFitness(
      brick,
      config.store,
      now,
      windowMs,
    );

    if (componentFitness === undefined) {
      // Can't compare — no component data, keep the brick
      return {
        brickId,
        action: "keep",
        fitnessOriginal: compositeFitness,
        reason: "No component tool data for comparison — keeping composite",
      };
    }

    // Compare composite vs aggregate component fitness
    if (componentFitness === 0 && compositeFitness === 0) {
      return {
        brickId,
        action: "keep",
        fitnessOriginal: compositeFitness,
        fitnessVariant: componentFitness,
        reason: "Both composite and component fitness are zero — keeping composite",
      };
    }

    if (compositeFitness > componentFitness * (1 + threshold)) {
      return {
        brickId,
        action: "keep",
        fitnessOriginal: compositeFitness,
        fitnessVariant: componentFitness,
        reason: `Composite is ${formatPercentage(compositeFitness, componentFitness)} better than components`,
      };
    }

    if (compositeFitness < componentFitness) {
      return {
        brickId,
        action: "deprecate",
        fitnessOriginal: compositeFitness,
        fitnessVariant: componentFitness,
        reason: `Composite is ${formatPercentage(componentFitness, compositeFitness)} worse than components`,
      };
    }

    // Within threshold — no significant difference, keep
    return {
      brickId,
      action: "keep",
      fitnessOriginal: compositeFitness,
      fitnessVariant: componentFitness,
      reason: "No significant difference between composite and components",
    };
  };

  const sweep = async (): Promise<readonly OptimizationResult[]> => {
    // Query for all active crystallized bricks
    const searchResult = await config.store.search({
      lifecycle: "active",
      kind: "tool",
    });

    if (!searchResult.ok) return [];

    const results: OptimizationResult[] = [];
    for (const brick of searchResult.value) {
      // Only evaluate crystallized bricks (check provenance source)
      if (!isCrystallizedBrick(brick)) continue;

      const result = await evaluate(brick.id);
      // justified: mutable local array being constructed, not shared state
      results.push(result);

      // Auto-deprecate bricks that should be deprecated
      if (result.action === "deprecate") {
        await config.store.update(brick.id, { lifecycle: "deprecated" });

        // Notify cross-agent caches about the deprecation
        if (config.notifier !== undefined) {
          void Promise.resolve(
            config.notifier.notify({ kind: "updated", brickId: brick.id }),
          ).catch(() => {});
        }
      }
    }

    return results;
  };

  return { evaluate, sweep };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a brick was created by crystallization (via provenance). */
function isCrystallizedBrick(brick: BrickArtifact): boolean {
  const source = brick.provenance.source;
  if (source.origin === "forged" && source.forgedBy === "auto-forge-middleware") {
    return true;
  }
  // Also check buildDefinition for crystallize build type
  return brick.provenance.buildDefinition.buildType.startsWith("koi.crystallize/");
}

/**
 * Compute aggregate fitness for component tools referenced in provenance.
 * Returns undefined if component tools can't be resolved.
 */
async function computeComponentAggregateFitness(
  brick: BrickArtifact,
  store: ForgeStore,
  now: number,
  windowMs: number,
): Promise<number | undefined> {
  // Extract component tool IDs from build definition external parameters
  const params = brick.provenance.buildDefinition.externalParameters;
  const ngramKey = params.ngramKey;
  if (typeof ngramKey !== "string") return undefined;

  // n-gram key is "toolA|toolB|toolC"
  const toolIds = ngramKey.split("|");
  if (toolIds.length === 0) return undefined;

  // Search for component tools by name
  let totalFitness = 0;
  let foundComponents = 0;

  for (const toolId of toolIds) {
    const searchResult = await store.search({
      kind: "tool",
      text: toolId,
      lifecycle: "active",
      limit: 1,
    });

    if (searchResult.ok && searchResult.value.length > 0) {
      const component = searchResult.value[0];
      if (component?.fitness !== undefined) {
        totalFitness += computeFitnessScore(component.fitness, now, windowMs);
        foundComponents += 1;
      }
    }
  }

  // Need at least one component with fitness data
  if (foundComponents === 0) return undefined;

  // Average fitness of available components
  return totalFitness / foundComponents;
}

/** Check if a brick was created by harness synthesis. */
function isHarnessSynthesizedBrick(brick: BrickArtifact): boolean {
  const source = brick.provenance.source;
  return source.origin === "forged" && source.forgedBy === "harness-synth";
}

/** Format percentage difference between two values. */
function formatPercentage(higher: number, lower: number): string {
  if (lower === 0) return "infinitely";
  const pct = ((higher - lower) / lower) * 100;
  return `${pct.toFixed(1)}%`;
}
