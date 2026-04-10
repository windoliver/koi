/**
 * InMemoryTranscript — Map-based store for tests and development.
 * No persistence across restarts. Implements the SessionTranscript contract.
 */

import type {
  CompactResult,
  KoiError,
  Result,
  SessionId,
  SessionTranscript,
  TranscriptEntry,
  TranscriptLoadResult,
  TranscriptPage,
  TranscriptPageOptions,
  TruncateResult,
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
  ): Result<CompactResult, KoiError> => {
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

    // Boundary extension: extend backward to avoid splitting tool_call/tool_result pairs
    const naiveCutIndex = Math.max(0, existing.length - preserveLastN);
    let cutIndex = naiveCutIndex;
    while (cutIndex > 0 && existing[cutIndex]?.role === "tool_result") {
      cutIndex--;
    }
    const preserved = existing.slice(cutIndex);
    const extended = cutIndex < naiveCutIndex;

    const compactionEntry: TranscriptEntry = {
      id: transcriptEntryId(`compaction-${Date.now()}`),
      role: "compaction",
      content: summary,
      timestamp: Date.now(),
    };
    store.set(sid, [compactionEntry, ...preserved]);
    return { ok: true, value: { preserved: preserved.length, extended } };
  };

  const truncate = (sid: SessionId, keepFirstN: number): Result<TruncateResult, KoiError> => {
    const check = validateNonEmpty(sid, "Session ID");
    if (!check.ok) return check;

    if (keepFirstN < 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "keepFirstN must be non-negative",
          retryable: false,
        },
      };
    }

    const existing = store.get(sid) ?? [];
    if (keepFirstN >= existing.length) {
      // Already shorter than the cap — nothing to drop.
      return { ok: true, value: { kept: existing.length, dropped: 0 } };
    }

    const kept = existing.slice(0, keepFirstN);
    const dropped = existing.length - kept.length;
    if (kept.length === 0) {
      // Truncating to zero — remove the entry entirely.
      store.delete(sid);
    } else {
      store.set(sid, kept);
    }
    return { ok: true, value: { kept: kept.length, dropped } };
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

  return { append, load, loadPage, compact, truncate, remove, close };
}
