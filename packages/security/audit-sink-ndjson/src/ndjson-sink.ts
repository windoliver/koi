/**
 * Buffered NDJSON file sink — one JSON object per line.
 *
 * Uses a Bun write stream opened once at creation, buffering lines in memory
 * and flushing on a configurable interval. No appendFile() syscall per record.
 * Redaction is the middleware's responsibility — this sink writes what it receives.
 *
 * Rotation (optional): when maxSizeBytes or daily is configured, the active file
 * is archived to <filePath>.archive/ and a fresh file is opened.
 *
 * Archive naming: `${seq8}-${uuid8}.ndjson` where seq is a per-sink monotonic
 * counter initialized from the max existing archive counter on startup. This makes
 * ordering independent of wall-clock timestamps, which can reorder under NTP
 * correction or VM clock rollback across process restarts.
 */

import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AuditEntry, AuditSink } from "@koi/core";
import type { NdjsonAuditSinkConfig } from "./config.js";

const DEFAULT_FLUSH_INTERVAL_MS = 2000;

/** Injected only in tests to simulate day changes without sleeping. */
type NdjsonClock = {
  todayUtc: () => string;
};

function defaultTodayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Parse the monotonic sequence prefix from an archive filename, or 0 if absent. */
function parseArchiveSeq(filename: string): number {
  const m = /^(\d{8})-/.exec(filename);
  if (m === null || m[1] === undefined) return 0;
  return parseInt(m[1], 10);
}

async function readEntriesFromFile(
  filePath: string,
  required = false,
): Promise<readonly AuditEntry[]> {
  try {
    const content = await readFile(filePath, "utf-8");
    const entries: AuditEntry[] = [];
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    let lineNum = 0;
    for (const line of lines) {
      lineNum++;
      try {
        entries.push(JSON.parse(line.trim()) as AuditEntry);
      } catch {
        throw new Error(`Audit log corrupted: line ${lineNum} failed to parse in ${filePath}`);
      }
    }
    return entries;
  } catch (e: unknown) {
    // ENOENT is benign only for the active file before it has been created.
    // For archive files (required=true), a missing file after enumeration is a
    // tamper or data-loss signal — fail closed so callers get an incomplete-read
    // error rather than silently returning a partial audit trail.
    if (
      !required &&
      e instanceof Error &&
      "code" in e &&
      (e as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw e;
  }
}

/**
 * Read the last non-empty line of a file and return its audit `timestamp` (ms) and UTC day.
 * Returns undefined if the file is empty, missing, or the last line is not a valid audit entry.
 */
async function readLastEntryMeta(
  filePath: string,
): Promise<{ readonly timestampMs: number; readonly day: string } | undefined> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const last = lines[lines.length - 1];
    if (last === undefined) return undefined;
    const parsed = JSON.parse(last.trim()) as Record<string, unknown>;
    if (typeof parsed.timestamp === "number") {
      return {
        timestampMs: parsed.timestamp,
        day: new Date(parsed.timestamp).toISOString().slice(0, 10),
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function readArchiveEntries(archiveDir: string): Promise<readonly AuditEntry[]> {
  let files: string[];
  try {
    files = await readdir(archiveDir);
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw e;
  }

  // Only ingest .ndjson files — stray .DS_Store, editor temps, or partial copies
  // must not cause a corruption error that takes the entire audit trail offline.
  // Sort by monotonic sequence prefix (clock-independent rotation order), with
  // filename as tiebreaker for archives that share the same sequence (should never
  // happen in practice, but defensively handled). Audit entry timestamps are not
  // used for ordering: entries are stamped with call start time, so a long-running
  // call can produce a timestamp older than entries already in a prior archive.
  const ndjsonFiles = files.filter((f) => f.endsWith(".ndjson"));
  ndjsonFiles.sort((a, b) => {
    const seqA = parseArchiveSeq(a);
    const seqB = parseArchiveSeq(b);
    return seqA !== seqB ? seqA - seqB : a < b ? -1 : a > b ? 1 : 0;
  });

  const results: AuditEntry[] = [];
  for (const file of ndjsonFiles) {
    // required=true: an archive was just enumerated by readdir — if it's now missing,
    // that is tampering or a race, not a benign empty-file case.
    const entries = await readEntriesFromFile(join(archiveDir, file), true);
    results.push(...entries);
  }
  return results;
}

export function createNdjsonAuditSink(
  config: NdjsonAuditSinkConfig & { _clockForTesting?: NdjsonClock },
): AuditSink & {
  readonly getEntries: () => Promise<readonly AuditEntry[]>;
  readonly flush: () => Promise<void>;
  readonly close: () => Promise<void>;
} {
  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const archiveDir = `${config.filePath}.archive`;

  // let — writer, size tracking, and rotation counter are replaced/updated on each rotation.
  let writer = Bun.file(config.filePath).writer();
  let bytesWritten = 0;
  let currentDay = config._clockForTesting?.todayUtc() ?? defaultTodayUtc();
  // Per-sink monotonic counter for archive filenames — immune to wall-clock skew.
  // Initialized from the max existing archive counter so it is strictly increasing
  // across process restarts within the same archive directory.
  let rotationSeq = 0;

  // Single-writer queue: all log()/flush()/close() calls are chained so rotation
  // is never re-entered concurrently and writes never race across a rotate boundary.
  // Seed bytesWritten from on-disk stat and, for daily rotation, currentDay from
  // the last entry's audit timestamp — not from mtime, which is mutable (backup
  // restores, external touch) and can silently suppress a required rotation.
  // Also read the archive dir to initialize rotationSeq above the max existing archive.
  let writeChain: Promise<void> = Promise.all([
    stat(config.filePath)
      .then(async (s) => {
        bytesWritten = s.size;
        if (config.rotation?.daily === true && s.size > 0) {
          const meta = await readLastEntryMeta(config.filePath);
          if (meta !== undefined) {
            currentDay = meta.day;
          }
        }
      })
      .catch(() => {
        /* ENOENT or unreadable — keep counter at 0 and currentDay as today */
      }),
    readdir(archiveDir)
      .then((files) => {
        let max = 0;
        for (const f of files) {
          const n = parseArchiveSeq(f);
          if (n > max) max = n;
        }
        rotationSeq = max;
      })
      .catch(() => {
        /* archive dir absent — rotationSeq stays 0 */
      }),
  ]).then(() => {});

  const timer = setInterval(() => {
    // Route through the write chain so the timer flush doesn't race rotation or close.
    writeChain = writeChain
      .then(() => Promise.resolve(writer.flush()).then(() => {}))
      .catch(() => {});
  }, flushIntervalMs);

  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  function nextArchiveName(): string {
    rotationSeq += 1;
    // UUID suffix prevents filename collision across process restarts (two runs
    // both starting from the same max seq would produce the same name without it).
    // Note: does NOT guarantee ordering when two concurrent writers share the archive
    // directory — use separate directories per writer (see getEntries() comment).
    const uuid = crypto.randomUUID().slice(0, 8);
    return `${String(rotationSeq).padStart(8, "0")}-${uuid}.ndjson`;
  }

  async function rotate(): Promise<void> {
    await Promise.resolve(writer.flush());

    await mkdir(archiveDir, { recursive: true });

    const archivePath = join(archiveDir, nextArchiveName());
    // End the writer only after the archive directory is ready. If rename() fails,
    // the writer has already ended but we reopen the original file so subsequent
    // log() calls still persist rather than silently dropping entries.
    await Promise.resolve(writer.end());
    try {
      await rename(config.filePath, archivePath);
    } catch (e: unknown) {
      // Archive move failed — reopen original file so the sink stays functional.
      writer = Bun.file(config.filePath).writer();
      throw new Error("audit log rotation failed: archive move unsuccessful", { cause: e });
    }

    writer = Bun.file(config.filePath).writer();
    bytesWritten = 0;
    currentDay = config._clockForTesting?.todayUtc() ?? defaultTodayUtc();
  }

  // pendingBytes: bytes about to be written in this call, so a write that would
  // push the file past maxSizeBytes triggers rotation before the line is appended.
  async function rotateIfNeeded(pendingBytes = 0): Promise<void> {
    if (!config.rotation) return;

    const today = config._clockForTesting?.todayUtc() ?? defaultTodayUtc();
    const bySize =
      config.rotation.maxSizeBytes !== undefined &&
      bytesWritten > 0 &&
      bytesWritten + pendingBytes > config.rotation.maxSizeBytes;
    // Guard bytesWritten > 0: no file to rename if this sink has never written anything
    const byDay = config.rotation.daily === true && today !== currentDay && bytesWritten > 0;

    if (bySize || byDay) {
      await rotate();
    }
  }

  function enqueue(task: () => Promise<void>): Promise<void> {
    writeChain = writeChain.then(task, task); // swallow upstream rejection so chain never stalls
    return writeChain;
  }

  return {
    log(entry: AuditEntry): Promise<void> {
      return enqueue(async () => {
        const line = `${JSON.stringify(entry)}\n`;
        // Use actual UTF-8 byte length, not UTF-16 code-unit count, so maxSizeBytes
        // matches the real on-disk size for entries containing multibyte characters.
        const lineBytes = Buffer.byteLength(line, "utf8");
        // Rotation failure propagates: caller receives a rejected promise so the
        // configured policy is known to be unenforced. rotate()'s recovery path
        // reopens the writer so the next log() call can retry.
        await rotateIfNeeded(lineBytes);
        writer.write(line);
        bytesWritten += lineBytes;
      });
    },

    flush(): Promise<void> {
      return enqueue(() => Promise.resolve(writer.flush()).then(() => {}));
    },

    getEntries(): Promise<readonly AuditEntry[]> {
      // Serialized through the write queue so rotation within this sink instance
      // cannot interleave with the snapshot.
      //
      // Single-writer contract: the archive directory must only have one active sink
      // writing into it at a time. Sequence numbers are per-process and initialized
      // from the on-disk max, so two concurrent writers will both claim the same next
      // sequence number producing nondeterministic archive ordering. Use separate
      // directories if multiple processes need independent sink instances.
      //
      // Active-file ENOENT handling: pass required=true so a missing active file
      // propagates to the catch block, allowing the archive to be re-scanned. This
      // handles a restart where the active file was rotated away and never recreated,
      // or a manual deletion of the active file between the archive snapshot and this read.
      let result: readonly AuditEntry[] = [];
      return enqueue(async () => {
        await Promise.resolve(writer.flush());
        const archived = await readArchiveEntries(archiveDir);
        try {
          const current = await readEntriesFromFile(config.filePath, true);
          result = [...archived, ...current];
        } catch (e: unknown) {
          if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
            if (bytesWritten > 0) {
              // This sink has written to the active file, but it is now missing.
              // This is data loss (external deletion or filesystem error) — fail
              // closed so callers see an error instead of a silently truncated trail.
              throw new Error(
                `audit log active file missing after ${bytesWritten} bytes were written — possible data loss`,
                { cause: e },
              );
            }
            // bytesWritten === 0: the active file was never written in this session.
            // Archives contain the full history from prior sink instances.
            result = archived;
          } else {
            throw e;
          }
        }
      }).then(() => result);
    },

    async query(sessionId: string): Promise<readonly AuditEntry[]> {
      const all = await this.getEntries();
      return all.filter((e) => e.sessionId === sessionId);
    },

    close(): Promise<void> {
      return enqueue(async () => {
        clearInterval(timer);
        await Promise.resolve(writer.flush());
        await Promise.resolve(writer.end());
      });
    },
  };
}
