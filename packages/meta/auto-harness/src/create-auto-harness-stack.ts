/**
 * createAutoHarnessStack — wires the auto-harness pipeline.
 *
 * L3 package: imports from multiple L2 packages (harness-synth, harness-search,
 * middleware-policy-cache, forge-optimizer) and produces a ready-to-use stack
 * for injection into the forge middleware pipeline.
 *
 * The closed loop:
 *   demand signal (repeated_failure)
 *   → aggregate failures (harness-synth)
 *   → synthesize middleware code (harness-synth + LLM)
 *   → iterative refinement (harness-search + Thompson sampling)
 *   → save to ForgeStore
 *   → policy promotion when 100% success (forge-optimizer)
 *   → policy-cache short-circuits model calls
 */

import type { BrickArtifact, ForgeDemandSignal, ImplementationArtifact } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { linearSearch } from "@koi/harness-search";
import {
  aggregateFailures,
  buildRefinementPrompt,
  parseSynthesisOutput,
  synthesize,
  type ToolFailureRecord,
} from "@koi/harness-synth";
import { computeBrickId, computeContentHash } from "@koi/hash";
import { createPolicyCacheMiddleware } from "@koi/middleware-policy-cache";
import type { AutoHarnessConfig, AutoHarnessStack } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_MAX_SYNTHESES = 3;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an auto-harness stack ready for injection into the forge pipeline.
 *
 * Returns:
 * - policyCacheMiddleware: Add to the agent's middleware chain
 * - synthesizeHarness: Pass to auto-forge config.synthesizeHarness
 * - maxSynthesesPerSession: Pass to auto-forge config
 */
export function createAutoHarnessStack(config: AutoHarnessConfig): AutoHarnessStack {
  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxSynthesesPerSession = config.maxSynthesesPerSession ?? DEFAULT_MAX_SYNTHESES;
  const clock = config.clock ?? Date.now;
  const random = config.random ?? Math.random;
  const onError =
    config.onError ??
    ((err: unknown) => {
      console.error("[auto-harness]", err);
    });

  // Create policy cache with notifier-based invalidation
  const policyCacheHandle = createPolicyCacheMiddleware({
    notifier: config.notifier,
  });

  // Session-level recursion gate: track which tools already have a synthesized harness.
  // The aggregator's forgedBy filter cannot work here because the demand signal context
  // carries only strings — no provenance metadata. This gate prevents the auto-harness
  // from synthesizing a second harness for the same tool in the same session.
  const synthesizedTools = new Set<string>();

  /**
   * The main synthesis callback — injected into auto-forge middleware.
   *
   * Given a demand signal with failure context, runs the full pipeline:
   * 1. Aggregate failures from the signal context
   * 2. Synthesize initial middleware code
   * 3. Run iterative refinement search
   * 4. Save the best variant to ForgeStore
   */
  async function synthesizeHarness(signal: ForgeDemandSignal): Promise<BrickArtifact | null> {
    const now = clock();
    const targetToolName = extractTargetToolName(signal);

    // Recursion prevention: skip if we already synthesized a harness for this tool
    if (synthesizedTools.has(targetToolName)) {
      return null;
    }

    // Extract failure data from the demand signal context
    const rawFailures = mapSignalToFailures(signal, now);
    if (rawFailures.length === 0) {
      return null;
    }

    // Aggregate and quality-filter failures
    const qualified = aggregateFailures(rawFailures, now);
    if (qualified === null) {
      return null; // Insufficient data
    }

    // Step 1: Initial synthesis
    const synthResult = await synthesize(
      {
        failures: qualified,
        targetToolName,
      },
      config.generate,
    );

    if (!synthResult.ok) {
      onError(new Error(`Synthesis failed: ${synthResult.reason}`));
      return null;
    }

    // Step 2: Iterative refinement via linear search
    const searchResult = await linearSearch(
      synthResult.value.code,
      {
        name: synthResult.value.descriptor.name,
        description: synthResult.value.descriptor.description,
      },
      {
        maxIterations,
        convergenceThreshold: 1.0,
        minEvalSamples: 5,
        noImprovementLimit: 3,
        clock,
        random,
        refine: async (currentCode, failures, iteration, totalIterations) => {
          const prompt = buildRefinementPrompt({
            targetToolName,
            currentCode,
            newFailures: failures.map((f) => ({
              timestamp: now,
              toolName: f.toolName,
              errorCode: f.errorCode,
              errorMessage: f.errorMessage,
              parameters: f.parameters,
            })),
            iterationNumber: iteration,
            totalIterations,
          });
          return config.generate(prompt);
        },
        evaluate: async (code, _descriptor) => {
          // Structural validation: parse the code to verify it has
          // createMiddleware export, wrapToolCall hook, correct API fields,
          // and lowercase phase. Full forge-verifier runs after search.
          const wrapped = `\`\`\`typescript\n${code}\n\`\`\``;
          const parseResult = parseSynthesisOutput(wrapped, targetToolName);
          if (parseResult.ok) {
            // Passes structural checks — report converged
            return { successRate: 1.0, sampleCount: 5, failures: [] };
          }
          // Failed structural validation — trigger refinement
          return {
            successRate: 0,
            sampleCount: 5,
            failures: [
              {
                toolName: targetToolName,
                errorCode: "STRUCTURAL_VALIDATION",
                errorMessage: parseResult.reason,
                parameters: {},
              },
            ],
          };
        },
      },
    );

    const bestCode = searchResult.best.code;

    // Step 3: Save to ForgeStore
    const brick = createHarnessBrick(targetToolName, bestCode, signal, now);
    const saveResult = await config.forgeStore.save(brick);
    if (!saveResult.ok) {
      onError(new Error(`Failed to save harness brick: ${saveResult.error.message}`));
      return null;
    }

    // Record that this tool now has a harness (recursion prevention)
    synthesizedTools.add(targetToolName);

    // Notify for hot-attach
    if (config.notifier !== undefined) {
      void Promise.resolve(
        config.notifier.notify({ kind: "saved", brickId: brick.id, scope: "agent" }),
      ).catch(() => {});
    }

    return brick;
  }

  return {
    policyCacheMiddleware: policyCacheHandle.middleware,
    policyCacheHandle,
    synthesizeHarness,
    maxSynthesesPerSession,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map demand signal context to ToolFailureRecord array. */
function mapSignalToFailures(signal: ForgeDemandSignal, now: number): readonly ToolFailureRecord[] {
  const ctx = signal.context;
  // failedToolCalls is readonly string[] — each entry is a tool call description
  if (ctx.failedToolCalls.length === 0) {
    return [];
  }

  const targetTool = extractTargetToolName(signal);

  return ctx.failedToolCalls.map((callDescription, index) => ({
    timestamp: now - index * 1000, // let: distinct timestamps for ordering
    toolName: targetTool,
    errorCode: computeContentHash(callDescription),
    errorMessage: callDescription,
    parameters: {},
  }));
}

/** Extract the target tool name from the demand signal trigger. */
function extractTargetToolName(signal: ForgeDemandSignal): string {
  if (signal.trigger.kind === "repeated_failure") {
    return signal.trigger.toolName;
  }
  if (signal.trigger.kind === "performance_degradation") {
    return signal.trigger.toolName;
  }
  return `harness-${signal.id}`;
}

/** Create an ImplementationArtifact (kind: "middleware") for the synthesized harness. */
function createHarnessBrick(
  toolName: string,
  code: string,
  signal: ForgeDemandSignal,
  now: number,
): ImplementationArtifact {
  const id = computeBrickId("middleware", code);
  return {
    id,
    kind: "middleware",
    name: `harness-${toolName}`,
    description: `Auto-synthesized harness middleware for ${toolName}. Prevents observed failure patterns.`,
    scope: "agent",
    origin: "forged",
    lifecycle: "draft",
    version: "0.1.0",
    usageCount: 0,
    implementation: code,
    policy: DEFAULT_SANDBOXED_POLICY,
    provenance: {
      source: {
        origin: "forged",
        forgedBy: "harness-synth",
        sessionId: `harness:${signal.id}`,
      },
      buildDefinition: {
        buildType: "koi.harness-synth/middleware/v1",
        externalParameters: {
          triggerKind: signal.trigger.kind,
          confidence: signal.confidence,
        },
      },
      builder: { id: "koi.harness-synth/auto-harness/v1" },
      metadata: {
        invocationId: `harness:${String(now)}`,
        startedAt: now,
        finishedAt: now,
        sessionId: `harness:${signal.id}`,
        agentId: "auto-harness",
        depth: 0,
      },
      verification: {
        passed: false,
        sandbox: false,
        totalDurationMs: 0,
        stageResults: [],
      },
      classification: "public",
      contentMarkers: [],
      contentHash: id,
    },
    tags: ["harness", "auto-synthesized", toolName],
  };
}
