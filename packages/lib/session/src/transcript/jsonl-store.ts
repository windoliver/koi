/**
 * JsonlTranscript — flat JSONL file-based transcript store for crash recovery.
 *
 * File layout: {baseDir}/{sessionId}.jsonl (flat — no date partitioning)
 * Each line is a JSON-serialized TranscriptEntry.
 *
 * Key design decisions:
 * - Flat layout: O(1) lookup, no directory traversal, ~50 fewer lines than v1
 * - Per-session async queue: prevents append+compact races (silent data loss)
 * - O_APPEND atomicity: appendFile uses O_APPEND for concurrent-safe per-write atomicity
 * - Atomic compaction: write-temp + rename (POSIX atomic)
 * - SkippedTranscriptEntry.reason: distinguishes crash artifacts from real corruption
 * - queues Map is instance-local (inside factory): separate instances don't interfere
 */

import { appendFile, mkdir, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CompactResult,
  KoiError,
  Result,
  SessionId,
  SessionTranscript,
  SkippedTranscriptEntry,
  TranscriptEntry,
  TranscriptLoadResult,
  TranscriptPage,
  TranscriptPageOptions,
  TruncateResult,
} from "@koi/core";
import { transcriptEntryId, validateNonEmpty } from "@koi/core";
import { extractMessage } from "@koi/errors";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface JsonlTranscriptConfig {
  readonly baseDir: string;
}

// ---------------------------------------------------------------------------
// Type guard for untrusted JSON
// ---------------------------------------------------------------------------

const VALID_ROLES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "system",
  "compaction",
]);

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.role === "string" &&
    VALID_ROLES.has(obj.role) &&
    typeof obj.content === "string" &&
    typeof obj.timestamp === "number"
  );
}

// ---------------------------------------------------------------------------
// JSONL parser
// ---------------------------------------------------------------------------

function parseJsonlLines(text: string): {
  readonly entries: readonly TranscriptEntry[];
  readonly skipped: readonly SkippedTranscriptEntry[];
} {
  const lines = text.split("\n");
  const entries: TranscriptEntry[] = [];
  const skipped: SkippedTranscriptEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;

    try {
      const parsed: unknown = JSON.parse(line);
      if (isTranscriptEntry(parsed)) {
        entries.push(parsed);
      } else {
        skipped.push({
          lineNumber: i + 1,
          raw: line,
          error: "Parsed JSON does not match TranscriptEntry schema",
          reason: "parse_error",
        });
      }
    } catch (e: unknown) {
      // A malformed last line is an expected crash artifact (partial write on crash).
      // Middle-line failures indicate real corruption.
      const isLastNonEmpty = lines.slice(i + 1).every((l) => l.trim() === "");
      skipped.push({
        lineNumber: i + 1,
        raw: line,
        error: isLastNonEmpty
          ? `Trailing malformed line (crash artifact): ${extractMessage(e)}`
          : extractMessage(e),
        reason: isLastNonEmpty ? "crash_artifact" : "parse_error",
      });
    }
  }

  return { entries, skipped };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// Module-level serialization queue keyed by ABSOLUTE FILE PATH.
//
// Keying by absolute path (not session ID) achieves two goals:
//
// 1. Cross-instance safety: two separate createJsonlTranscript() instances
//    with the same baseDir pointing at the same session file are still
//    serialized — compact()'s write-temp + rename cannot race an in-flight
//    append from another instance.
//
// 2. Test isolation: instances with DIFFERENT baseDirs produce different
//    absolute paths and therefore different queue keys, so parallel tests
//    never share a queue entry even if they use the same session ID.
//
// Single-process guarantee only: multi-process concurrent access requires a
// backend with transactional semantics (e.g. SQLite WAL).
const _queues = new Map<string, Promise<void>>();

export function createJsonlTranscript(config: JsonlTranscriptConfig): SessionTranscript {
  const { baseDir } = config;

  function serialized<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = _queues.get(path) ?? Promise.resolve();
    // Run fn regardless of whether prev resolved or rejected
    const result = prev.then(
      () => fn(),
      () => fn(),
    );
    // Store a void-typed tail so the next operation can chain on it
    const tail = result.then(
      () => {
        /* next op may proceed */
      },
      () => {
        /* error — next op still proceeds */
      },
    );
    _queues.set(path, tail);
    // GC: once this tail settles with no subsequent op queued, remove the entry.
    // Prevents unbounded Map growth in long-lived processes with many transient sessions.
    void tail.then(() => {
      if (_queues.get(path) === tail) _queues.delete(path);
    });
    return result;
  }

  function filePath(sid: string): string {
    // URL-encode the session ID to produce a safe filename for any session ID
    // format (including runtime IDs like "agent:xxx:uuid" that contain colons).
    // encodeURIComponent replaces /, :, and other special chars — path traversal
    // is structurally impossible because the encoded string contains no / separators.
    // resolve() canonicalizes the path so _queues entries are stable across callers
    // that pass relative vs absolute baseDir (same file → same queue key).
    return resolve(baseDir, `${encodeURIComponent(sid)}.jsonl`);
  }

  const append = async (
    sid: SessionId,
    entries: readonly TranscriptEntry[],
  ): Promise<Result<void, KoiError>> => {
    const check = validateNonEmpty(sid, "Session ID");
    if (!check.ok) return check;
    if (entries.length === 0) return { ok: true, value: undefined };

    return serialized(filePath(sid), async () => {
      try {
        await mkdir(baseDir, { recursive: true });
        const jsonl = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
        // appendFile uses O_APPEND — kernel-atomic per-write, safe under concurrent processes
        await appendFile(filePath(sid), jsonl);
        return { ok: true as const, value: undefined };
      } catch (e: unknown) {
        return {
          ok: false as const,
          error: {
            code: "INTERNAL" as const,
            message: `Failed to append transcript: ${extractMessage(e)}`,
            retryable: false,
            cause: e,
          },
        };
      }
    });
  };

  const load = async (sid: SessionId): Promise<Result<TranscriptLoadResult, KoiError>> => {
    const check = validateNonEmpty(sid, "Session ID");
    if (!check.ok) return check;

    try {
      const file = Bun.file(filePath(sid));
      if (!(await file.exists())) {
        return { ok: true, value: { entries: [], skipped: [] } };
      }
      const text = await file.text();
      return { ok: true, value: parseJsonlLines(text) };
    } catch (e: unknown) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Failed to load transcript: ${extractMessage(e)}`,
          retryable: false,
          cause: e,
        },
      };
    }
  };

  const loadPage = async (
    sid: SessionId,
    options: TranscriptPageOptions,
  ): Promise<Result<TranscriptPage, KoiError>> => {
    const check = validateNonEmpty(sid, "Session ID");
    if (!check.ok) return check;

    // Full-load-then-slice: O(n) memory, intentional for CLI use.
    // Transcripts are compacted before growing large enough for this to matter.
    const loadResult = await load(sid);
    if (!loadResult.ok) return loadResult;

    const all = loadResult.value.entries;
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

  const compact = async (
    sid: SessionId,
    summary: string,
    preserveLastN: number,
  ): Promise<Result<CompactResult, KoiError>> => {
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

    return serialized(filePath(sid), async () => {
      try {
        const file = Bun.file(filePath(sid));
        if (!(await file.exists())) {
          return { ok: true as const, value: { preserved: 0, extended: false } };
        }

        const text = await file.text();
        const { entries } = parseJsonlLines(text);

        // Boundary extension (decision 12-B): if the naive cut lands on a tool_result
        // entry, extend backward until the cut is before the tool_call that owns it.
        // This prevents the compaction from splitting a tool_call/tool_result pair —
        // a split pair causes replay to fail because the model sees an orphan result.
        const naiveCutIndex = Math.max(0, entries.length - preserveLastN);
        let cutIndex = naiveCutIndex;
        while (cutIndex > 0 && entries[cutIndex]?.role === "tool_result") {
          cutIndex--;
        }
        const preserved = entries.slice(cutIndex);
        const extended = cutIndex < naiveCutIndex;

        const compactionEntry: TranscriptEntry = {
          id: transcriptEntryId(`compaction-${Date.now()}`),
          role: "compaction",
          content: summary,
          timestamp: Date.now(),
        };

        const jsonl = `${[compactionEntry, ...preserved].map((e) => JSON.stringify(e)).join("\n")}\n`;

        // Atomic replace: write to temp, then rename (POSIX atomic)
        const tmp = `${filePath(sid)}.tmp`;
        await Bun.write(tmp, jsonl);
        await rename(tmp, filePath(sid));

        return { ok: true as const, value: { preserved: preserved.length, extended } };
      } catch (e: unknown) {
        return {
          ok: false as const,
          error: {
            code: "INTERNAL" as const,
            message: `Failed to compact transcript: ${extractMessage(e)}`,
            retryable: false,
            cause: e,
          },
        };
      }
    });
  };

  const truncate = async (
    sid: SessionId,
    keepFirstN: number,
  ): Promise<Result<TruncateResult, KoiError>> => {
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

    return serialized(filePath(sid), async () => {
      try {
        const file = Bun.file(filePath(sid));
        if (!(await file.exists())) {
          return { ok: true as const, value: { kept: 0, dropped: 0 } };
        }

        const text = await file.text();
        const { entries } = parseJsonlLines(text);

        if (keepFirstN >= entries.length) {
          // Nothing to drop — log is already shorter than the requested cap.
          return { ok: true as const, value: { kept: entries.length, dropped: 0 } };
        }

        const kept = entries.slice(0, keepFirstN);
        const dropped = entries.length - kept.length;

        if (kept.length === 0) {
          // Truncating to zero entries — remove the file rather than leave
          // an empty JSONL behind.
          await unlink(filePath(sid));
          return { ok: true as const, value: { kept: 0, dropped } };
        }

        const jsonl = `${kept.map((e) => JSON.stringify(e)).join("\n")}\n`;
        // Atomic replace: write to temp, then rename (POSIX atomic).
        const tmp = `${filePath(sid)}.tmp`;
        await Bun.write(tmp, jsonl);
        await rename(tmp, filePath(sid));

        return { ok: true as const, value: { kept: kept.length, dropped } };
      } catch (e: unknown) {
        return {
          ok: false as const,
          error: {
            code: "INTERNAL" as const,
            message: `Failed to truncate transcript: ${extractMessage(e)}`,
            retryable: false,
            cause: e,
          },
        };
      }
    });
  };

  const remove = async (sid: SessionId): Promise<Result<void, KoiError>> => {
    const check = validateNonEmpty(sid, "Session ID");
    if (!check.ok) return check;

    // Serialized to prevent delete racing with an in-flight append or compact
    // (e.g. compact rename could resurrect a transcript after unlink).
    return serialized(filePath(sid), async () => {
      try {
        const file = Bun.file(filePath(sid));
        if (await file.exists()) {
          await unlink(filePath(sid));
        }
        return { ok: true as const, value: undefined };
      } catch (e: unknown) {
        return {
          ok: false as const,
          error: {
            code: "INTERNAL" as const,
            message: `Failed to remove transcript: ${extractMessage(e)}`,
            retryable: false,
            cause: e,
          },
        };
      }
    });
  };

  const close = (): void => {
    // No resources to release for file-based store
  };

  return { append, load, loadPage, compact, truncate, remove, close };
}
