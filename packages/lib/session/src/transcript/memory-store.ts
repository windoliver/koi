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

  const append = (sid: SessionId, entries: readonly TranscriptEntry[]): Result<void, KoiError> => {
    const check = validateNonEmpty(sid, "Session ID");
    if (!check.ok) return check;

    if (entries.length === 0) return { ok: true, value: undefined };

    store.set(sid, [...(store.get(sid) ?? []), ...entries]);
    return { ok: true, value: undefined };
  };

  const load = (sid: SessionId): Result<TranscriptLoadResult, KoiError> => {
    const check = validateNonEmpty(sid, "Session ID");
    if (!check.ok) return check;

    return { ok: true, value: { entries: store.get(sid) ?? [], skipped: [] } };
  };

  const loadPage = (
    sid: SessionId,
    options: TranscriptPageOptions,
  ): Result<TranscriptPage, KoiError> => {
    const check = validateNonEmpty(sid, "Session ID");
    if (!check.ok) return check;

    const all = store.get(sid) ?? [];
    const offset = options.offset ?? 0;
    return {
      ok: true,
      value: {
        entries: all.slice(offset, offset + options.limit),
        total: all.length,
        hasMore: offset + options.limit < all.length,
      },
    };
  };

  const compact = (
    sid: SessionId,
    summary: string,
    preserveLastN: number,
  ): Result<void, KoiError> => {
    const check = validateNonEmpty(sid, "Session ID");
    if (!check.ok) return check;

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

    const existing = store.get(sid) ?? [];
    const compactionEntry: TranscriptEntry = {
      id: transcriptEntryId(`compaction-${Date.now()}`),
      role: "compaction",
      content: summary,
      timestamp: Date.now(),
    };
    const preserved = preserveLastN === 0 ? [] : existing.slice(-preserveLastN);
    store.set(sid, [compactionEntry, ...preserved]);
    return { ok: true, value: undefined };
  };

  const remove = (sid: SessionId): Result<void, KoiError> => {
    const check = validateNonEmpty(sid, "Session ID");
    if (!check.ok) return check;

    store.delete(sid);
    return { ok: true, value: undefined };
  };

  const close = (): void => {
    store.clear();
  };

  return { append, load, loadPage, compact, remove, close };
}
