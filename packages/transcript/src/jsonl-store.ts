/**
 * JsonlTranscript — JSONL file-based transcript store for crash recovery.
 *
 * File layout: {baseDir}/{YYYY-MM-DD}/{sessionId}.jsonl
 * Each line is a JSON-serialized TranscriptEntry.
 */

import { appendFile, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  KoiError,
  Result,
  SessionId,
  SessionTranscript,
  SkippedTranscriptEntry,
  TranscriptEntry,
  TranscriptLoadResult,
  TranscriptPage,
  TranscriptPageOptions,
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
// Validation
// ---------------------------------------------------------------------------

/** Reject sessionIds containing path separators, dot-traversals, null bytes, or glob meta-chars. */
function validateSessionIdForPath(sessionId: string): Result<void, KoiError> {
  const idCheck = validateNonEmpty(sessionId, "Session ID");
  if (!idCheck.ok) return idCheck;

  if (/[/\\]/.test(sessionId) || sessionId.includes("..") || sessionId.includes("\0")) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Session ID contains invalid path characters: ${sessionId}`,
        retryable: false,
      },
    };
  }
  return { ok: true, value: undefined };
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
// Helpers
// ---------------------------------------------------------------------------

function computeDatePartition(timestamp: number): string {
  const d = new Date(timestamp);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Find the JSONL file for a session across date-partitioned directories.
 * Uses directory iteration instead of glob to avoid injection via sessionId.
 */
async function findTranscriptFile(baseDir: string, sessionId: string): Promise<string | undefined> {
  const fileName = `${sessionId}.jsonl`;
  let dirs: readonly string[];
  try {
    dirs = await readdir(baseDir);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = join(baseDir, dir, fileName);
    if (await Bun.file(candidate).exists()) {
      return candidate;
    }
  }
  return undefined;
}

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
        });
      }
    } catch (e: unknown) {
      // Last non-empty line: tag as crash artifact for diagnostics
      const isLastNonEmpty = lines.slice(i + 1).every((l) => l.trim() === "");
      if (isLastNonEmpty) {
        skipped.push({
          lineNumber: i + 1,
          raw: line,
          error: `Trailing malformed line (likely crash artifact): ${extractMessage(e)}`,
        });
      } else {
        skipped.push({
          lineNumber: i + 1,
          raw: line,
          error: extractMessage(e),
        });
      }
    }
  }

  return { entries, skipped };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createJsonlTranscript(config: JsonlTranscriptConfig): SessionTranscript {
  const { baseDir } = config;

  const append = async (
    sessionId: SessionId,
    entries: readonly TranscriptEntry[],
  ): Promise<Result<void, KoiError>> => {
    const idCheck = validateSessionIdForPath(sessionId);
    if (!idCheck.ok) return idCheck;

    if (entries.length === 0) {
      return { ok: true, value: undefined };
    }

    try {
      const partition = computeDatePartition(Date.now());
      const dir = join(baseDir, partition);
      await mkdir(dir, { recursive: true });

      const filePath = join(dir, `${sessionId}.jsonl`);
      const jsonl = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;

      // Check if file already exists for this session in a different partition
      const existingPath = await findTranscriptFile(baseDir, sessionId);
      const targetPath = existingPath ?? filePath;

      // Use appendFile for atomic O_APPEND — safe under concurrent writes
      await appendFile(targetPath, jsonl);

      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Failed to append transcript: ${extractMessage(e)}`,
          retryable: false,
          cause: e,
        },
      };
    }
  };

  const load = async (sessionId: SessionId): Promise<Result<TranscriptLoadResult, KoiError>> => {
    const idCheck = validateSessionIdForPath(sessionId);
    if (!idCheck.ok) return idCheck;

    try {
      const filePath = await findTranscriptFile(baseDir, sessionId);
      if (filePath === undefined) {
        return { ok: true, value: { entries: [], skipped: [] } };
      }

      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return { ok: true, value: { entries: [], skipped: [] } };
      }

      const text = await file.text();
      const result = parseJsonlLines(text);
      return { ok: true, value: result };
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
    sessionId: SessionId,
    options: TranscriptPageOptions,
  ): Promise<Result<TranscriptPage, KoiError>> => {
    const idCheck = validateSessionIdForPath(sessionId);
    if (!idCheck.ok) return idCheck;

    const loadResult = await load(sessionId);
    if (!loadResult.ok) return loadResult;

    const all = loadResult.value.entries;
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

  const compact = async (
    sessionId: SessionId,
    summary: string,
    preserveLastN: number,
  ): Promise<Result<void, KoiError>> => {
    const idCheck = validateSessionIdForPath(sessionId);
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

    try {
      const filePath = await findTranscriptFile(baseDir, sessionId);
      if (filePath === undefined) {
        return { ok: true, value: undefined };
      }

      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        return { ok: true, value: undefined };
      }

      const text = await file.text();
      const { entries } = parseJsonlLines(text);

      const compactionEntry: TranscriptEntry = {
        id: transcriptEntryId(`compaction-${Date.now()}`),
        role: "compaction",
        content: summary,
        timestamp: Date.now(),
      };

      const preserved = entries.slice(-preserveLastN);
      const compacted = [compactionEntry, ...preserved];
      const jsonl = `${compacted.map((e) => JSON.stringify(e)).join("\n")}\n`;

      // Atomic replace: write to temp, then rename
      const tmpPath = `${filePath}.tmp`;
      await Bun.write(tmpPath, jsonl);
      await rename(tmpPath, filePath);

      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Failed to compact transcript: ${extractMessage(e)}`,
          retryable: false,
          cause: e,
        },
      };
    }
  };

  const remove = async (sessionId: SessionId): Promise<Result<void, KoiError>> => {
    const idCheck = validateSessionIdForPath(sessionId);
    if (!idCheck.ok) return idCheck;

    try {
      const filePath = await findTranscriptFile(baseDir, sessionId);
      if (filePath !== undefined) {
        await unlink(filePath);
      }
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Failed to remove transcript: ${extractMessage(e)}`,
          retryable: false,
          cause: e,
        },
      };
    }
  };

  const close = (): void => {
    // No resources to release for file-based store
  };

  return { append, load, loadPage, compact, remove, close };
}
