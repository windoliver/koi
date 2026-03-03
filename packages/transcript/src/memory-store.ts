/**
 * InMemoryTranscript — Map-based store for tests and development.
 * No persistence across restarts. Implements the SessionTranscript contract.
 */

import type {
  KoiError,
  Result,
  SessionId,
  SessionTranscript,
  TranscriptEntry,
  TranscriptLoadResult,
  TranscriptPage,
  TranscriptPageOptions,
} from "@koi/core";
import { transcriptEntryId, validateNonEmpty } from "@koi/core";

export function createInMemoryTranscript(): SessionTranscript {
  const store = new Map<string, readonly TranscriptEntry[]>();

  const append = (
    sessionId: SessionId,
    entries: readonly TranscriptEntry[],
  ): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;

    if (entries.length === 0) {
      return { ok: true, value: undefined };
    }

    const existing = store.get(sessionId) ?? [];
    store.set(sessionId, [...existing, ...entries]);
    return { ok: true, value: undefined };
  };

  const load = (sessionId: SessionId): Result<TranscriptLoadResult, KoiError> => {
    const idCheck = validateNonEmpty(sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;

    const entries = store.get(sessionId) ?? [];
    return { ok: true, value: { entries, skipped: [] } };
  };

  const loadPage = (
    sessionId: SessionId,
    options: TranscriptPageOptions,
  ): Result<TranscriptPage, KoiError> => {
    const idCheck = validateNonEmpty(sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;

    const all = store.get(sessionId) ?? [];
    const offset = options.offset ?? 0;
    const entries = all.slice(offset, offset + options.limit);
    return {
      ok: true,
      value: {
        entries,
        total: all.length,
        hasMore: offset + options.limit < all.length,
      },
    };
  };

  const compact = (
    sessionId: SessionId,
    summary: string,
    preserveLastN: number,
  ): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;

    if (preserveLastN < 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "preserveLastN must be non-negative",
          retryable: false,
        },
      };
    }

    const existing = store.get(sessionId) ?? [];
    const compactionEntry: TranscriptEntry = {
      id: transcriptEntryId(`compaction-${Date.now()}`),
      role: "compaction",
      content: summary,
      timestamp: Date.now(),
    };
    const preserved = existing.slice(-preserveLastN);
    store.set(sessionId, [compactionEntry, ...preserved]);
    return { ok: true, value: undefined };
  };

  const remove = (sessionId: SessionId): Result<void, KoiError> => {
    const idCheck = validateNonEmpty(sessionId, "Session ID");
    if (!idCheck.ok) return idCheck;

    store.delete(sessionId);
    return { ok: true, value: undefined };
  };

  const close = (): void => {
    store.clear();
  };

  return { append, load, loadPage, compact, remove, close };
}
