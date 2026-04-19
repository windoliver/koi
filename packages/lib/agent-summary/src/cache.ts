import { computeContentHash } from "@koi/hash";
import type {
  Focus,
  Granularity,
  ModelHint,
  SessionId,
  SkippedTranscriptEntry,
  SummaryCache,
  SummaryOk,
  TranscriptEntry,
} from "./types.js";

// §6.2 authoritative cache-identity contract. Any change here MUST also update
// §6.2 of the spec, the factory data-flow pseudocode, and validate.ts expected
// fields (see §11 lockstep checkpoint).
export interface CacheKeyInput {
  readonly sessionId: SessionId;
  readonly fromTurn: number;
  readonly toTurn: number;
  readonly entries: readonly TranscriptEntry[];
  readonly granularity: Granularity;
  readonly focus: Required<Focus>;
  readonly maxTokens: number;
  readonly modelHint: ModelHint;
  readonly schemaVersion: 1;
  readonly promptVersion: number;
  readonly degraded: boolean;
  readonly skipped: readonly SkippedTranscriptEntry[];
  readonly hasCompactionPrefix: boolean;
  readonly compactionEntryCount: number;
  readonly droppedTailTurns: number;
}

export function cacheKey(input: CacheKeyInput): string {
  return computeContentHash({
    sessionId: input.sessionId,
    fromTurn: input.fromTurn,
    toTurn: input.toTurn,
    entries: input.entries,
    granularity: input.granularity,
    focus: input.focus,
    maxTokens: input.maxTokens,
    modelHint: input.modelHint,
    schemaVersion: input.schemaVersion,
    promptVersion: input.promptVersion,
    degraded: input.degraded,
    skippedFingerprint: fingerprint(input.degraded, input.skipped),
    hasCompactionPrefix: input.hasCompactionPrefix,
    compactionEntryCount: input.compactionEntryCount,
    droppedTailTurns: input.droppedTailTurns,
  });
}

interface FingerprintItem {
  readonly lineNumber: number;
  readonly reason: string;
  readonly raw: string;
  readonly error: string;
}

function fingerprint(
  degraded: boolean,
  skipped: readonly SkippedTranscriptEntry[],
): readonly FingerprintItem[] | null {
  if (!degraded) return null;
  return skipped
    .map((s) => ({
      lineNumber: s.lineNumber,
      reason: s.reason,
      raw: s.raw,
      error: s.error,
    }))
    .toSorted((a, b) => a.lineNumber - b.lineNumber);
}

export function createMemoryCache(): SummaryCache {
  const store = new Map<string, SummaryOk>();
  return {
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, value);
    },
  };
}
