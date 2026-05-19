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
import type { NexusTransport } from "@koi/nexus-client";
import { deletePath, readText, writeText } from "./json-io.js";
import { transcriptPath } from "./paths.js";

const VALID_ROLES: ReadonlySet<string> = new Set([
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "system",
  "compaction",
]);

const queues = new Map<string, Promise<void>>();

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

function parseJsonlLines(text: string): TranscriptLoadResult {
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
    } catch (error: unknown) {
      const isLastNonEmpty = lines.slice(i + 1).every((candidate) => candidate.trim() === "");
      skipped.push({
        lineNumber: i + 1,
        raw: line,
        error: error instanceof Error ? error.message : String(error),
        reason: isLastNonEmpty ? "crash_artifact" : "parse_error",
      });
    }
  }

  return { entries, skipped };
}

function toJsonl(entries: readonly TranscriptEntry[]): string {
  if (entries.length === 0) return "";
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.then(
    () => fn(),
    () => fn(),
  );
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}

export function createNexusTranscriptStore(
  transport: NexusTransport,
  basePath: string,
  lockScope: string,
): SessionTranscript {
  function pathFor(sessionId: string): string {
    return transcriptPath(basePath, sessionId);
  }

  const append: SessionTranscript["append"] = async (
    sid: SessionId,
    entries: readonly TranscriptEntry[],
  ): Promise<Result<void, KoiError>> => {
    const check = validateNonEmpty(sid, "Session ID");
    if (!check.ok) return check;
    if (entries.length === 0) return { ok: true, value: undefined };

    return serialized(`${lockScope}:transcript:${sid}`, async () => {
      const path = pathFor(sid);
      const existing = await readText(transport, path);
      if (!existing.ok) return existing;
      return writeText(transport, path, `${existing.value ?? ""}${toJsonl(entries)}`);
    });
  };

  const load: SessionTranscript["load"] = async (
    sid: SessionId,
  ): Promise<Result<TranscriptLoadResult, KoiError>> => {
    const check = validateNonEmpty(sid, "Session ID");
    if (!check.ok) return check;
    const existing = await readText(transport, pathFor(sid));
    if (!existing.ok) return existing;
    return { ok: true, value: parseJsonlLines(existing.value ?? "") };
  };

  const loadPage: SessionTranscript["loadPage"] = async (
    sid: SessionId,
    options: TranscriptPageOptions,
  ): Promise<Result<TranscriptPage, KoiError>> => {
    const result = await load(sid);
    if (!result.ok) return result;
    const offset = options.offset ?? 0;
    return {
      ok: true,
      value: {
        entries: result.value.entries.slice(offset, offset + options.limit),
        total: result.value.entries.length,
        hasMore: offset + options.limit < result.value.entries.length,
      },
    };
  };

  const compact: SessionTranscript["compact"] = async (
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
    return serialized(`${lockScope}:transcript:${sid}`, async () => {
      const loaded = await load(sid);
      if (!loaded.ok) return loaded;
      if (loaded.value.entries.length === 0) {
        return { ok: true, value: { preserved: 0, extended: false } };
      }
      const naiveCutIndex = Math.max(0, loaded.value.entries.length - preserveLastN);
      let cutIndex = naiveCutIndex;
      while (cutIndex > 0 && loaded.value.entries[cutIndex]?.role === "tool_result") {
        cutIndex--;
      }
      const preserved = loaded.value.entries.slice(cutIndex);
      const compactionEntry: TranscriptEntry = {
        id: transcriptEntryId(`compaction-${Date.now()}`),
        role: "compaction",
        content: summary,
        timestamp: Date.now(),
      };
      const written = await writeText(
        transport,
        pathFor(sid),
        toJsonl([compactionEntry, ...preserved]),
      );
      if (!written.ok) return written;
      return {
        ok: true,
        value: { preserved: preserved.length, extended: cutIndex < naiveCutIndex },
      };
    });
  };

  const truncate: SessionTranscript["truncate"] = async (
    sid: SessionId,
    keepFirstN: number,
  ): Promise<Result<TruncateResult, KoiError>> => {
    const check = validateNonEmpty(sid, "Session ID");
    if (!check.ok) return check;
    if (keepFirstN < 0) {
      return {
        ok: false,
        error: { code: "VALIDATION", message: "keepFirstN must be non-negative", retryable: false },
      };
    }
    return serialized(`${lockScope}:transcript:${sid}`, async () => {
      const loaded = await load(sid);
      if (!loaded.ok) return loaded;
      if (keepFirstN >= loaded.value.entries.length) {
        return { ok: true, value: { kept: loaded.value.entries.length, dropped: 0 } };
      }
      const kept = loaded.value.entries.slice(0, keepFirstN);
      const dropped = loaded.value.entries.length - kept.length;
      const result =
        kept.length === 0
          ? await deletePath(transport, pathFor(sid))
          : await writeText(transport, pathFor(sid), toJsonl(kept));
      if (!result.ok) return result;
      return { ok: true, value: { kept: kept.length, dropped } };
    });
  };

  const remove: SessionTranscript["remove"] = async (
    sid: SessionId,
  ): Promise<Result<void, KoiError>> => {
    const check = validateNonEmpty(sid, "Session ID");
    if (!check.ok) return check;
    return serialized(`${lockScope}:transcript:${sid}`, () => deletePath(transport, pathFor(sid)));
  };

  return {
    append,
    load,
    loadPage,
    compact,
    truncate,
    remove,
    close: () => undefined,
  };
}
