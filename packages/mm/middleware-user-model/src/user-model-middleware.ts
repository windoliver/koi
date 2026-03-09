/**
 * createUserModelMiddleware — unified preference learning + drift detection + sensor enrichment.
 *
 * Priority 415 (replaces personalization at 420 and preference-drift at 410).
 * Phase: "resolve" — transforms context, doesn't gate/block.
 *
 * Signal processing pipeline (onBeforeTurn):
 * 1. Read signal sources in parallel with per-source timeout
 * 2. Extract last user message text
 * 3. Run correction detector (fail-open: swallow errors)
 * 4. Run drift detector (fail-closed: assume drift on error)
 * 5. Ingest all collected signals via sink
 * 6. Invalidate snapshot cache
 *
 * Context injection (wrapModelCall):
 * 1. Build snapshot (lazy cached)
 * 2. Format [User Context] block with sub-budgets
 * 3. Inject as pinned message
 */

import type { MemoryResult } from "@koi/core/ecs";
import type { InboundMessage } from "@koi/core/message";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  SessionContext,
  TurnContext,
} from "@koi/core/middleware";
import type { UserSignal, UserSnapshot } from "@koi/core/user-model";
import { swallowError } from "@koi/errors";
import { resolveUserModelDefaults } from "./config.js";
import { formatUserContext } from "./context-injector.js";
import type { PreferenceDriftSignal } from "./keyword-drift.js";
import { readSignalSources } from "./signal-reader.js";
import { createSnapshotCache } from "./snapshot-cache.js";
import { extractLastMessageText } from "./text-extractor.js";
import type { ResolvedUserModelConfig, UserModelConfig } from "./types.js";

const MIN_WORDS_FOR_CORRECTION = 5;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).length;
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

function filterByRelevance(
  results: readonly MemoryResult[],
  threshold: number,
): readonly MemoryResult[] {
  return results.filter((r) => (r.score ?? 1) >= threshold);
}

function computeCapabilityDescription(cfg: ResolvedUserModelConfig): string {
  const channels: string[] = [];
  if (cfg.preAction.enabled) channels.push("clarify");
  if (cfg.postAction.enabled) channels.push("correct");
  if (cfg.drift.enabled) channels.push("drift");
  if (cfg.signalSources.length > 0) channels.push("sensor");

  if (channels.length === 0) return "User model inactive";
  return `User model active (${channels.join(" + ")})`;
}

export function createUserModelMiddleware(config: UserModelConfig): KoiMiddleware {
  const cfg = resolveUserModelDefaults(config);
  const snapshotCache = createSnapshotCache();
  const capabilityDescription = computeCapabilityDescription(cfg);
  const capabilityFragment: CapabilityFragment = {
    label: "user-model",
    description: capabilityDescription,
  };

  // Accumulated sensor state across turns (mutable accumulator)
  let sensorState: Record<string, unknown> = {}; // let: mutable sensor accumulator
  const activeSessions = new Set<string>();

  // Turn-level memory recall cache (keyed by query to avoid stale cross-query hits)
  let recallCache:
    | { readonly query: string; readonly results: readonly MemoryResult[] }
    | undefined; // let: mutable recall cache

  function handleError(error: unknown): void {
    if (cfg.onError) {
      cfg.onError(error);
    } else {
      swallowError(error, {
        package: "middleware-user-model",
        operation: "user-model",
      });
    }
  }

  async function ingestSignal(signal: UserSignal): Promise<void> {
    if (signal.kind === "sensor") {
      // Merge sensor values into accumulated state
      sensorState = { ...sensorState, [signal.source]: signal.values };
    }

    if (signal.kind === "post_action") {
      // Store correction as preference
      const storeOptions: {
        readonly namespace: string;
        readonly category: string;
        readonly supersedes?: readonly string[];
      } = {
        namespace: cfg.preferenceNamespace,
        category: cfg.preferenceCategory,
        ...(signal.supersedes !== undefined && signal.supersedes.length > 0
          ? { supersedes: signal.supersedes }
          : {}),
      };
      await cfg.memory.store(signal.correction, storeOptions);
    }

    snapshotCache.invalidate();
    recallCache = undefined;
  }

  async function recallPreferences(query: string): Promise<readonly MemoryResult[]> {
    if (recallCache !== undefined && recallCache.query === query) return recallCache.results;

    const results = await cfg.memory.recall(query, {
      namespace: cfg.preferenceNamespace,
      limit: cfg.recallLimit,
    });
    recallCache = { query, results };
    return results;
  }

  async function buildSnapshot(messageText: string): Promise<UserSnapshot> {
    const cached = snapshotCache.get();
    if (cached !== undefined) return cached;

    const allResults = await recallPreferences(messageText);
    const relevant = filterByRelevance(allResults, cfg.relevanceThreshold);

    // Check ambiguity if pre-action enabled and no relevant preferences
    let ambiguityDetected = false; // let: computed per-snapshot
    let suggestedQuestion: string | undefined; // let: computed per-snapshot

    if (cfg.preAction.enabled && relevant.length === 0 && messageText.length > 0) {
      try {
        const assessment = await cfg.preAction.classifier.classify(messageText, relevant);
        ambiguityDetected = assessment.ambiguous;
        suggestedQuestion = assessment.suggestedDirective;
      } catch (error: unknown) {
        handleError(error);
      }
    }

    const snapshot: UserSnapshot = {
      preferences: relevant,
      state: { ...sensorState },
      ambiguityDetected,
      suggestedQuestion,
    };

    snapshotCache.set(snapshot);
    return snapshot;
  }

  return {
    name: "user-model",
    priority: 415,
    phase: "resolve",

    describeCapabilities: (_ctx: TurnContext) => capabilityFragment,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      activeSessions.add(ctx.sessionId as string);
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const sessionId = ctx.session.sessionId as string;
      if (!activeSessions.has(sessionId)) return;

      // Reset turn-level caches
      recallCache = undefined;
      snapshotCache.invalidate();

      // 1. Read signal sources in parallel
      if (cfg.signalSources.length > 0) {
        try {
          const readResult = await readSignalSources(cfg.signalSources, cfg.signalTimeoutMs);
          for (const signal of readResult.signals) {
            await ingestSignal(signal);
          }
        } catch (error: unknown) {
          handleError(error);
        }
      }

      // 2. Extract last user message text
      const messageText = extractLastMessageText(ctx.messages);
      if (messageText.length === 0) return;

      // 3. Run correction detector (fail-open: swallow errors)
      if (cfg.postAction.enabled && ctx.turnIndex > 0) {
        if (
          wordCount(messageText) >= MIN_WORDS_FOR_CORRECTION ||
          looksLikeCorrection(messageText)
        ) {
          try {
            const assessment = await cfg.postAction.detector.detect(messageText, ctx.messages);
            if (assessment.corrective && assessment.preferenceUpdate) {
              await ingestSignal({
                kind: "post_action",
                correction: assessment.preferenceUpdate,
                source: "explicit",
              });
            }
          } catch (error: unknown) {
            handleError(error);
          }
        }
      }

      // 4. Run drift detector (fail-closed: assume drift on error)
      if (cfg.drift.enabled) {
        let driftSignal: PreferenceDriftSignal; // let: may be reassigned on error
        try {
          driftSignal = await cfg.drift.detector.detect(messageText);
        } catch (_e: unknown) {
          // Fail-closed: assume drift
          driftSignal = { kind: "drift_detected", newPreference: messageText };
        }

        if (driftSignal.kind === "drift_detected") {
          // Find supersession targets
          const recalled = await recallPreferences(
            driftSignal.oldPreference ?? driftSignal.newPreference,
          );
          const matchingOldFacts = recalled.filter((r) => {
            const meta = r.metadata as Readonly<Record<string, unknown>> | undefined;
            return meta?.category === cfg.preferenceCategory && meta?.status === "active";
          });

          // Check salience gate
          let shouldStore = true; // let: may be gated
          if (cfg.salienceGate !== undefined) {
            try {
              shouldStore = await cfg.salienceGate.isSalient(
                driftSignal.newPreference,
                cfg.preferenceCategory,
              );
            } catch (_e: unknown) {
              // Fail-open: treat as salient
              shouldStore = true;
            }
          }

          if (shouldStore) {
            const supersedeIds = matchingOldFacts
              .map((r) => (r.metadata as Readonly<Record<string, unknown>>)?.id)
              .filter((id): id is string => typeof id === "string");

            await ingestSignal({
              kind: "post_action",
              correction: driftSignal.newPreference,
              source: "drift",
              ...(supersedeIds.length > 0 ? { supersedes: supersedeIds } : {}),
            });
          }
        }
      }
    },

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const messageText = extractLastMessageText(request.messages);
      const snapshot = await buildSnapshot(messageText);

      const contextText = formatUserContext(snapshot, {
        maxPreferenceTokens: cfg.maxPreferenceTokens,
        maxSensorTokens: cfg.maxSensorTokens,
        maxMetaTokens: cfg.maxMetaTokens,
      });

      if (contextText !== undefined) {
        const contextMessage: InboundMessage = {
          senderId: "system:user-model",
          timestamp: Date.now(),
          content: [{ kind: "text", text: contextText }],
          pinned: true,
        };
        return next({ ...request, messages: [contextMessage, ...request.messages] });
      }

      return next(request);
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      activeSessions.delete(ctx.sessionId as string);
      if (activeSessions.size === 0) {
        sensorState = {};
        recallCache = undefined;
        snapshotCache.invalidate();
      }
    },
  };
}
