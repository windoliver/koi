/**
 * Crystallize middleware — observes tool call patterns after each turn
 * and surfaces crystallization candidates via callback.
 *
 * Runs in `onAfterTurn` at priority 950 (after event-trace at 475).
 * Observe-only — never auto-forges.
 */

import type { CapabilityFragment, KoiMiddleware, TurnContext } from "@koi/core";
import { detectPatterns } from "./detect-patterns.js";
import type { CrystallizationCandidate, CrystallizeConfig, CrystallizeHandle } from "./types.js";

// ---------------------------------------------------------------------------
// Default config values
// ---------------------------------------------------------------------------

const DEFAULT_MIN_TURNS_BEFORE_ANALYSIS = 5;
const DEFAULT_ANALYSIS_COOLDOWN_TURNS = 3;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a crystallize middleware that detects repeating tool patterns.
 *
 * The middleware reads from a SnapshotChainStore<TurnTrace> (written by event-trace middleware)
 * and fires `onCandidatesDetected` when new patterns are found.
 */
export function createCrystallizeMiddleware(config: CrystallizeConfig): CrystallizeHandle {
  const clock = config.clock ?? Date.now;
  const minTurns = config.minTurnsBeforeAnalysis ?? DEFAULT_MIN_TURNS_BEFORE_ANALYSIS;
  const cooldown = config.analysisCooldownTurns ?? DEFAULT_ANALYSIS_COOLDOWN_TURNS;

  // Encapsulated mutable state
  // justified: mutable state is encapsulated within the factory closure
  let candidates: readonly CrystallizationCandidate[] = [];
  const dismissed = new Set<string>();
  let lastAnalysisTurn = -Infinity;
  let knownKeys = new Set<string>();

  const middleware: KoiMiddleware = {
    name: "crystallize",
    priority: 950,

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      const currentTurn = ctx.turnIndex;

      // Skip if not enough turns yet
      if (currentTurn < minTurns) return;

      // Skip if within cooldown
      if (currentTurn - lastAnalysisTurn < cooldown) return;

      lastAnalysisTurn = currentTurn;

      // Read all traces from the store
      const listResult = await config.store.list(config.chainId);
      if (!listResult.ok) return;

      const traces = listResult.value.map((node) => node.data);
      if (traces.length < minTurns) return;

      // Detect patterns
      const detected = detectPatterns(
        traces,
        {
          minNgramSize: config.minNgramSize,
          maxNgramSize: config.maxNgramSize,
          minOccurrences: config.minOccurrences,
          maxCandidates: config.maxCandidates,
        },
        dismissed,
        clock,
      );

      // Fire callback only for NEW candidates (not previously seen)
      const newCandidates = detected.filter((c) => !knownKeys.has(c.ngram.key));

      if (newCandidates.length > 0) {
        // Update known keys
        knownKeys = new Set([...knownKeys, ...newCandidates.map((c) => c.ngram.key)]);
        candidates = detected;
        config.onCandidatesDetected(newCandidates);
      } else {
        candidates = detected;
      }
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      if (candidates.length === 0) return undefined;
      return {
        label: "crystallize",
        description: `${candidates.length} repeating tool pattern${candidates.length === 1 ? "" : "s"} detected — consider forging as reusable bricks`,
      };
    },
  };

  return {
    middleware,
    getCandidates: () => candidates,
    dismiss: (ngramKey: string): void => {
      dismissed.add(ngramKey);
      candidates = candidates.filter((c) => c.ngram.key !== ngramKey);
      knownKeys.delete(ngramKey);
    },
  };
}
