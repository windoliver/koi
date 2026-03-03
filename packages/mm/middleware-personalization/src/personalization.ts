/**
 * Personalization middleware factory — dual-channel preference learning.
 *
 * Pre-action: injects relevant preferences + clarification directives.
 * Post-action: detects corrections and stores preference updates.
 */

import type { MemoryResult } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core/middleware";
import { swallowError } from "@koi/errors";
import { estimateTokens } from "@koi/token-estimator";
import { createDefaultAmbiguityClassifier } from "./ambiguity-classifier.js";
import type { PersonalizationConfig, ResolvedPersonalizationConfig } from "./config.js";
import { resolveDefaults } from "./config.js";
import { createDefaultCorrectionDetector } from "./correction-detector.js";
import { createPreferenceCache } from "./preference-cache.js";
import { extractLastMessageText } from "./text-extractor.js";

const MIN_WORDS_FOR_CORRECTION = 5;
const PREFERENCE_CATEGORY = "preference";

function computeCapabilityDescription(cfg: ResolvedPersonalizationConfig): string {
  const pre = cfg.preAction.enabled;
  const post = cfg.postAction.enabled;

  if (pre && post) return "User preference learning active (clarify + correct)";
  if (pre) return "User preference learning active (clarify only)";
  if (post) return "User preference learning active (correct only)";
  return "User preference learning inactive";
}

function filterByRelevance(
  results: readonly MemoryResult[],
  threshold: number,
): readonly MemoryResult[] {
  return results.filter((r) => (r.score ?? 1) >= threshold);
}

function capByTokenBudget(
  results: readonly MemoryResult[],
  maxTokens: number,
): readonly MemoryResult[] {
  const capped: MemoryResult[] = [];
  let tokensUsed = 0; // let: accumulator for token budget

  for (const r of results) {
    const tokens = estimateTokens(r.content);
    if (tokensUsed + tokens > maxTokens) break;
    tokensUsed += tokens;
    capped.push(r);
  }

  return capped;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).length;
}

export function createPersonalizationMiddleware(config: PersonalizationConfig): KoiMiddleware {
  const cfg = resolveDefaults(
    config,
    createDefaultAmbiguityClassifier(),
    createDefaultCorrectionDetector(),
  );

  const cache = createPreferenceCache();
  const capabilityDescription = computeCapabilityDescription(cfg);

  const capabilityFragment: CapabilityFragment = {
    label: "personalization",
    description: capabilityDescription,
  };

  async function recallPreferences(query: string): Promise<readonly MemoryResult[]> {
    const cached = cache.get();
    if (cached !== undefined) return cached;

    const results = await cfg.memory.recall(query, {
      namespace: cfg.preferenceNamespace,
    });
    cache.set(results);
    return results;
  }

  function handleError(error: unknown): void {
    if (cfg.onError) {
      cfg.onError(error);
    } else {
      swallowError(error, {
        package: "middleware-personalization",
        operation: "preference-learning",
      });
    }
  }

  return {
    name: "personalization",
    priority: 420,

    describeCapabilities: (_ctx: TurnContext) => capabilityFragment,

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const messageText = extractLastMessageText(request.messages);

      // --- Post-action channel: detect corrections from previous turn ---
      if (cfg.postAction.enabled && ctx.turnIndex > 0 && messageText.length > 0) {
        // Short-circuit: skip very short messages without correction markers
        if (
          wordCount(messageText) >= MIN_WORDS_FOR_CORRECTION ||
          looksLikeCorrection(messageText)
        ) {
          try {
            const assessment = await cfg.postAction.detector.detect(messageText, request.messages);

            if (assessment.corrective && assessment.preferenceUpdate) {
              await cfg.memory.store(assessment.preferenceUpdate, {
                namespace: cfg.preferenceNamespace,
                category: PREFERENCE_CATEGORY,
              });
              cache.invalidate();
            }
          } catch (error: unknown) {
            handleError(error);
          }
        }
      }

      // --- Pre-action channel: inject preferences or clarification ---
      if (cfg.preAction.enabled) {
        try {
          const preferences = await recallPreferences(messageText);
          const relevant = filterByRelevance(preferences, cfg.relevanceThreshold);
          const capped = capByTokenBudget(relevant, cfg.maxPreferenceTokens);

          if (capped.length > 0) {
            const prefText = capped.map((p) => p.content).join("\n");
            const prefMessage: InboundMessage = {
              senderId: "system:personalization",
              timestamp: Date.now(),
              content: [{ kind: "text", text: `[User Preferences]\n${prefText}` }],
              pinned: true,
            };
            return next({ ...request, messages: [prefMessage, ...request.messages] });
          }

          // No relevant preferences — check ambiguity
          const assessment = await cfg.preAction.classifier.classify(messageText, relevant);

          if (assessment.ambiguous && assessment.suggestedDirective) {
            const directiveMessage: InboundMessage = {
              senderId: "system:personalization",
              timestamp: Date.now(),
              content: [{ kind: "text", text: assessment.suggestedDirective }],
              pinned: true,
            };
            return next({ ...request, messages: [directiveMessage, ...request.messages] });
          }
        } catch (error: unknown) {
          handleError(error);
        }
      }

      return next(request);
    },
  };
}

/** Quick check for correction markers without running the full detector. */
function looksLikeCorrection(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return (
    lower.startsWith("no,") ||
    lower.startsWith("actually,") ||
    lower.startsWith("instead,") ||
    lower.includes("i prefer") ||
    lower.includes("i meant")
  );
}
