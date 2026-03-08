/**
 * Exaptation detector middleware factory.
 *
 * Monitors tool usage context to detect when bricks are repurposed
 * beyond their original design. Emits ExaptationSignal when purpose
 * drift is detected across multiple agents.
 */

import type {
  CapabilityFragment,
  ExaptationSignal,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
  UsagePurposeObservation,
} from "@koi/core";
import { computeExaptationConfidence } from "./confidence.js";
import { computeJaccardDistance, tokenize, truncateToWords } from "./divergence.js";
import { detectPurposeDrift } from "./heuristics.js";
import type { ExaptationConfig, ExaptationHandle, ExaptationThresholds } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PENDING_SIGNALS = 10;
const DEFAULT_MAX_OBSERVATIONS_PER_BRICK = 30;
const DEFAULT_MAX_CONTEXT_WORDS = 200;

const DEFAULT_THRESHOLDS: ExaptationThresholds = {
  minObservations: 5,
  divergenceThreshold: 0.7,
  minDivergentAgents: 2,
  confidenceWeight: 0.8,
} as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an exaptation detector middleware.
 *
 * Returns an ExaptationHandle bundling the middleware + signal query API.
 */
export function createExaptationDetector(config: ExaptationConfig): ExaptationHandle {
  const clock = config.clock ?? Date.now;
  const maxPending = config.maxPendingSignals ?? DEFAULT_MAX_PENDING_SIGNALS;
  const maxObs = config.maxObservationsPerBrick ?? DEFAULT_MAX_OBSERVATIONS_PER_BRICK;
  const maxWords = config.maxContextWords ?? DEFAULT_MAX_CONTEXT_WORDS;
  const thresholds: ExaptationThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...config.thresholds,
  };

  // Mutable state — encapsulated within closure
  // let: ring buffers, caches, signal queue, cooldowns
  const observations = new Map<string, UsagePurposeObservation[]>();
  const toolDescriptionCache = new Map<string, ReadonlySet<string>>();
  const toolDescriptionText = new Map<string, string>();
  const signals: ExaptationSignal[] = [];
  const cooldowns = new Map<string, number>();

  // let: monotonically increasing signal counter for unique IDs
  let signalCounter = 0;

  // Session-keyed model response text, captured by wrapModelCall
  const lastModelResponseBySession = new Map<string, string>();

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function isOnCooldown(brickId: string): boolean {
    const lastEmitted = cooldowns.get(brickId);
    if (lastEmitted === undefined) return false;
    return clock() - lastEmitted < config.cooldownMs;
  }

  function pushObservation(toolId: string, obs: UsagePurposeObservation): void {
    const buffer = observations.get(toolId);
    if (buffer === undefined) {
      observations.set(toolId, [obs]);
    } else {
      // Ring buffer — evict oldest when full
      if (buffer.length >= maxObs) {
        buffer.shift();
      }
      buffer.push(obs);
    }
  }

  function getOrCacheTokens(toolId: string, description: string): ReadonlySet<string> {
    const cached = toolDescriptionCache.get(toolId);
    if (cached !== undefined) return cached;
    const tokens = tokenize(description);
    toolDescriptionCache.set(toolId, tokens);
    toolDescriptionText.set(toolId, description);
    return tokens;
  }

  function computeAverageDivergence(obs: readonly UsagePurposeObservation[]): number {
    if (obs.length === 0) return 0;
    // let: accumulator
    let sum = 0;
    for (const o of obs) {
      sum += o.divergenceScore;
    }
    return sum / obs.length;
  }

  function countDivergentAgents(obs: readonly UsagePurposeObservation[]): number {
    const agents = new Set<string>();
    for (const o of obs) {
      if (o.divergenceScore >= thresholds.divergenceThreshold) {
        agents.add(o.agentId);
      }
    }
    return agents.size;
  }

  function getTopContexts(
    obs: readonly UsagePurposeObservation[],
    maxCount: number,
  ): readonly string[] {
    // Sort by divergence descending, take top N unique contexts
    const sorted = [...obs].sort((a, b) => b.divergenceScore - a.divergenceScore);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const o of sorted) {
      if (!seen.has(o.contextText) && o.contextText.length > 0) {
        seen.add(o.contextText);
        result.push(o.contextText);
        if (result.length >= maxCount) break;
      }
    }
    return result;
  }

  function emitSignal(
    toolId: string,
    toolName: string,
    statedPurpose: string,
    obs: readonly UsagePurposeObservation[],
  ): void {
    if (isOnCooldown(toolId)) return;

    const avgDivergence = computeAverageDivergence(obs);
    const agentCount = countDivergentAgents(obs);

    const confidence = computeExaptationConfidence(
      avgDivergence,
      agentCount,
      obs.length,
      thresholds,
    );

    signalCounter++;
    const signal: ExaptationSignal = {
      id: `exaptation-${String(signalCounter)}`,
      kind: "exaptation",
      exaptationKind: "purpose_drift",
      brickId: toolId,
      brickName: toolName,
      confidence,
      statedPurpose,
      observedContexts: getTopContexts(obs, 5),
      divergenceScore: avgDivergence,
      agentCount,
      emittedAt: clock(),
    };

    // Bounded queue — evict oldest if full
    if (signals.length >= maxPending) {
      signals.shift();
    }
    signals.push(signal);
    cooldowns.set(toolId, clock());
    config.onSignal?.(signal);
  }

  function dismiss(signalId: string): void {
    const idx = signals.findIndex((s) => s.id === signalId);
    if (idx === -1) return;

    const signal = signals[idx];
    if (signal !== undefined) {
      cooldowns.delete(signal.brickId);
    }
    signals.splice(idx, 1);
    config.onDismiss?.(signalId);
  }

  // -------------------------------------------------------------------------
  // Middleware
  // -------------------------------------------------------------------------

  const middleware: KoiMiddleware = {
    name: "forge-exaptation-detector",
    priority: 465,

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const response = await next(request);

      // Capture model response text keyed by session for the next wrapToolCall
      const sid = ctx.session.sessionId;
      if (typeof response.content === "string" && response.content.length > 0) {
        lastModelResponseBySession.set(sid, truncateToWords(response.content, maxWords));
      } else {
        lastModelResponseBySession.set(sid, "");
      }

      // Cache tool descriptions from the request if available
      if (request.tools !== undefined) {
        for (const tool of request.tools) {
          if (tool.description.length > 0) {
            getOrCacheTokens(tool.name, tool.description);
          }
        }
      }

      return response;
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const chunks: string[] = [];
      for await (const chunk of next(request)) {
        if (chunk.kind === "text_delta") {
          chunks.push(chunk.delta);
        }
        yield chunk;
      }

      const responseText = chunks.join("");
      const sid = ctx.session.sessionId;
      if (responseText.length > 0) {
        lastModelResponseBySession.set(sid, truncateToWords(responseText, maxWords));
      } else {
        lastModelResponseBySession.set(sid, "");
      }

      if (request.tools !== undefined) {
        for (const tool of request.tools) {
          if (tool.description.length > 0) {
            getOrCacheTokens(tool.name, tool.description);
          }
        }
      }
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const { toolId } = request;
      const agentId = ctx.session.agentId;

      // Observe intent before executing the tool call
      const modelResponseText = lastModelResponseBySession.get(ctx.session.sessionId) ?? "";
      const descriptionTokens = toolDescriptionCache.get(toolId);
      if (
        descriptionTokens !== undefined &&
        descriptionTokens.size > 0 &&
        modelResponseText.length > 0
      ) {
        const contextTokens = tokenize(modelResponseText);
        const divergence = computeJaccardDistance(descriptionTokens, contextTokens);

        const observation: UsagePurposeObservation = {
          contextText: modelResponseText,
          agentId,
          divergenceScore: divergence,
          observedAt: clock(),
        };

        pushObservation(toolId, observation);

        // Check for purpose drift
        const brickObs = observations.get(toolId);
        if (brickObs !== undefined) {
          const kind = detectPurposeDrift(brickObs, thresholds);
          if (kind !== undefined) {
            const statedPurpose = toolDescriptionText.get(toolId) ?? "";
            emitSignal(toolId, toolId, statedPurpose, brickObs);
          }
        }
      }

      return next(request);
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      if (signals.length === 0) return undefined;
      return {
        label: "forge-exaptation",
        description: `Exaptation: ${String(signals.length)} purpose drift${signals.length === 1 ? "" : "s"} detected — consider generalizing or forging specialized bricks`,
      };
    },
  };

  return {
    middleware,
    getSignals: (): readonly ExaptationSignal[] => [...signals],
    dismiss,
    getActiveSignalCount: (): number => signals.length,
  };
}
