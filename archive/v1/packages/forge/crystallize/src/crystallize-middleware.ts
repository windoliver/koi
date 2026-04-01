/**
 * Crystallize middleware -- observes tool call patterns after each turn
 * and surfaces crystallization candidates via callback.
 *
 * Runs in `onAfterTurn` at priority 950 (after event-trace at 475).
 * Observe-only -- never auto-forges.
 *
 * Uses incremental detection for efficiency in long sessions.
 * TTL-based eviction: known keys and dismissed keys expire after maxPatternAgeMs.
 */

import type { CapabilityFragment, KoiMiddleware, TurnContext } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { detectPatternsIncremental } from "./detect-patterns.js";
import type { NgramEntry } from "./ngram.js";
import type { CrystallizationCandidate, CrystallizeConfig, CrystallizeHandle } from "./types.js";
import { validateCrystallizeConfig } from "./validate-config.js";

// ---------------------------------------------------------------------------
// TTL eviction helper
// ---------------------------------------------------------------------------

/**
 * Evict entries older than maxAgeMs from a timestamp map.
 * Returns a new map (immutable -- does not mutate input).
 */
function evictStaleEntries(
  entries: ReadonlyMap<string, number>,
  now: number,
  maxAgeMs: number,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const [key, timestamp] of entries) {
    if (now - timestamp < maxAgeMs) {
      result.set(key, timestamp);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a crystallize middleware that detects repeating tool patterns.
 *
 * Reads traces via the `readTraces` callback (typically backed by a SnapshotChainStore)
 * and fires `onCandidatesDetected` when new patterns are found.
 *
 * Uses incremental detection to avoid reprocessing all turns every time.
 *
 * @throws KoiRuntimeError with code "VALIDATION" if config is invalid.
 */
export function createCrystallizeMiddleware(config: CrystallizeConfig): CrystallizeHandle {
  const result = validateCrystallizeConfig(config);
  if (!result.ok) {
    throw KoiRuntimeError.from("VALIDATION", result.error.message);
  }
  const validated = result.value;

  // Encapsulated mutable state
  // justified: mutable state is encapsulated within the factory closure
  let candidates: readonly CrystallizationCandidate[] = [];
  let dismissed = new Map<string, number>(); // key -> timestamp
  let lastAnalysisTurn = -Infinity;
  let knownKeys = new Map<string, number>(); // key -> timestamp
  let ngramMap: ReadonlyMap<string, NgramEntry> = new Map();
  let lastProcessedTurnIndex = -1;

  const middleware: KoiMiddleware = {
    name: "crystallize",
    priority: 950,

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      const currentTurn = ctx.turnIndex;

      // Skip if not enough turns yet
      if (currentTurn < validated.minTurnsBeforeAnalysis) return;

      // Skip if within cooldown
      if (currentTurn - lastAnalysisTurn < validated.analysisCooldownTurns) return;

      lastAnalysisTurn = currentTurn;

      const now = validated.clock();

      // Evict stale entries before analysis
      knownKeys = evictStaleEntries(knownKeys, now, validated.maxPatternAgeMs);
      dismissed = evictStaleEntries(dismissed, now, validated.maxPatternAgeMs);

      // Build a Set view of dismissed keys for the detectPatterns API
      const dismissedSet = new Set(dismissed.keys());

      // Read all traces via the decoupled callback
      const tracesResult = await validated.readTraces();
      if (!tracesResult.ok) return;

      const traces = tracesResult.value;
      if (traces.length < validated.minTurnsBeforeAnalysis) return;

      // Compute new traces since last processed index
      const startIndex = lastProcessedTurnIndex + 1;
      const newTraces = traces.slice(startIndex);

      // Detect patterns incrementally
      const detection = detectPatternsIncremental(
        newTraces,
        startIndex,
        ngramMap,
        {
          minNgramSize: validated.minNgramSize,
          maxNgramSize: validated.maxNgramSize,
          minOccurrences: validated.minOccurrences,
          maxCandidates: validated.maxCandidates,
          firstSeenTimes: knownKeys,
        },
        dismissedSet,
        validated.clock,
      );

      // Update incremental state for next call
      ngramMap = detection.ngramMap;
      lastProcessedTurnIndex = detection.lastProcessedTurnIndex;

      const detected = detection.candidates;

      // Fire callback only for NEW candidates (not previously seen)
      const newCandidates = detected.filter((c) => !knownKeys.has(c.ngram.key));

      if (newCandidates.length > 0) {
        // Update known keys with current timestamp
        const updatedKnown = new Map(knownKeys);
        for (const c of newCandidates) {
          updatedKnown.set(c.ngram.key, now);
        }
        knownKeys = updatedKnown;
        candidates = detected;
        validated.onCandidatesDetected(newCandidates);
      } else {
        candidates = detected;
      }
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      if (candidates.length === 0) return undefined;
      return {
        label: "crystallize",
        description: `${candidates.length} repeating tool pattern${candidates.length === 1 ? "" : "s"} detected \u2014 consider forging as reusable bricks`,
      };
    },
  };

  return {
    middleware,
    getCandidates: () => candidates,
    dismiss: (ngramKey: string): void => {
      const now = validated.clock();
      const updatedDismissed = new Map(dismissed);
      updatedDismissed.set(ngramKey, now);
      dismissed = updatedDismissed;
      candidates = candidates.filter((c) => c.ngram.key !== ngramKey);
      const updatedKnown = new Map(knownKeys);
      updatedKnown.delete(ngramKey);
      knownKeys = updatedKnown;
    },
  };
}
