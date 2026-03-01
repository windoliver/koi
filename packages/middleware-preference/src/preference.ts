/**
 * createPreferenceMiddleware — Detects preference drift and gates memory stores.
 *
 * Runs in onBeforeTurn:
 * 1. Extract text from last user message
 * 2. Run drift detector
 * 3. If drift detected: recall old preferences, check salience, store with supersession
 *
 * Error handling: drift fail-closed (assume drift on error), salience fail-open (store on error).
 */

import type { MemoryComponent, MemoryResult } from "@koi/core/ecs";
import type { ContentBlock } from "@koi/core/message";
import type { KoiMiddleware, SessionContext, TurnContext } from "@koi/core/middleware";
import { createCascadedDriftDetector } from "./cascaded-drift.js";
import type { PreferenceMiddlewareConfig } from "./config.js";
import { createKeywordDriftDetector } from "./keyword-drift.js";
import { createLlmSalienceGate } from "./llm-salience.js";
import type { PreferenceDriftDetector, PreferenceDriftSignal, SalienceGate } from "./types.js";

const DEFAULT_RECALL_LIMIT = 5;
const DEFAULT_PREFERENCE_CATEGORY = "preference";

function extractLastUserText(ctx: TurnContext): string | undefined {
  const messages = ctx.messages;
  if (messages.length === 0) return undefined;

  const last = messages[messages.length - 1];
  if (last === undefined) return undefined;

  const textBlocks = last.content.filter(
    (
      block: ContentBlock,
    ): block is ContentBlock & { readonly kind: "text"; readonly text: string } =>
      block.kind === "text",
  );

  if (textBlocks.length === 0) return undefined;
  return textBlocks.map((b: { readonly text: string }) => b.text).join("\n");
}

function resolveDetector(config: PreferenceMiddlewareConfig): PreferenceDriftDetector {
  if (config.driftDetector !== undefined) return config.driftDetector;
  if (config.classify !== undefined) {
    return createCascadedDriftDetector(config.classify, {
      additionalPatterns: config.additionalPatterns,
    });
  }
  return createKeywordDriftDetector({
    additionalPatterns: config.additionalPatterns,
  });
}

function resolveSalienceGate(config: PreferenceMiddlewareConfig): SalienceGate | undefined {
  if (config.salienceGate !== undefined) return config.salienceGate;
  if (config.classify !== undefined) return createLlmSalienceGate(config.classify);
  return undefined;
}

export function createPreferenceMiddleware(config: PreferenceMiddlewareConfig): KoiMiddleware {
  const detector = resolveDetector(config);
  const gate = resolveSalienceGate(config);
  const memory: MemoryComponent | undefined = config.memory;
  const recallLimit = config.recallLimit ?? DEFAULT_RECALL_LIMIT;
  const preferenceCategory = config.preferenceCategory ?? DEFAULT_PREFERENCE_CATEGORY;
  // Track active sessions so we can skip turns for ended/unknown sessions
  const activeSessions = new Set<string>();

  return {
    name: "preference-drift",
    priority: 410,

    describeCapabilities: () => ({
      label: "preference-drift",
      description: "Detects preference changes and supersedes stale memory",
    }),

    async onSessionStart(ctx: SessionContext): Promise<void> {
      activeSessions.add(ctx.sessionId as string);
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const sessionId = ctx.session.sessionId as string;
      if (!activeSessions.has(sessionId)) return;

      const text = extractLastUserText(ctx);
      if (text === undefined) return;

      // --- Drift detection (fail-closed) ---
      // let — signal may be reassigned on error path
      let signal: PreferenceDriftSignal;
      try {
        signal = await detector.detect(text, ctx);
      } catch (_e: unknown) {
        // Fail-closed: assume drift when detector throws
        signal = { kind: "drift_detected" as const, newPreference: text };
      }

      if (signal.kind === "no_drift") return;

      // --- Memory operations ---
      if (memory === undefined) return;

      // Recall existing preferences to find supersession targets
      const query = signal.oldPreference ?? signal.newPreference;
      const recalled: readonly MemoryResult[] = await memory.recall(query, {
        limit: recallLimit,
      });

      // Filter by preference category.
      // ASSUMPTION: memory backend populates metadata with { id, category, status }.
      // Guaranteed by @koi/memory-fs but not by the MemoryComponent contract.
      const matchingOldFacts = recalled.filter((r) => {
        const meta = r.metadata as Readonly<Record<string, unknown>> | undefined;
        return meta?.category === preferenceCategory && meta?.status === "active";
      });

      // --- Salience gate (fail-open) ---
      if (gate !== undefined) {
        // let — salient may be reassigned on error path
        let salient: boolean;
        try {
          salient = await gate.isSalient(signal.newPreference, preferenceCategory);
        } catch (_e: unknown) {
          // Fail-open: treat as salient when gate throws
          salient = true;
        }
        if (!salient) return;
      }

      // --- Store new preference with supersession ---
      const supersedeIds = matchingOldFacts
        .map((r) => (r.metadata as Readonly<Record<string, unknown>>)?.id)
        .filter((id): id is string => typeof id === "string");

      await memory.store(signal.newPreference, {
        category: preferenceCategory,
        ...(supersedeIds.length > 0 ? { supersedes: supersedeIds } : {}),
      });
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      activeSessions.delete(ctx.sessionId as string);
    },
  };
}
