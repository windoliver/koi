/**
 * Buffered NDJSON file sink — one JSON object per line.
 *
 * Uses a Bun write stream opened once at creation, buffering lines in memory
 * and flushing on a configurable interval. No appendFile() syscall per record.
 * Redaction is the middleware's responsibility — this sink writes what it receives.
 *
 * Rotation (optional): when maxSizeBytes or daily is configured, the active file
 * is archived to <filePath>.archive/ and a fresh file is opened.
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

let rotationCounter = 0;

function rotationTimestamp(): string {
  // Counter suffix guarantees uniqueness when two rotations occur within the same ms
  const ts = new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-");
  rotationCounter += 1;
  return `${ts}-${String(rotationCounter).padStart(4, "0")}`;
}

async function readEntriesFromFile(filePath: string): Promise<readonly AuditEntry[]> {
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
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw e;
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

  const sorted = [...files].sort(); // ISO timestamps sort lexicographically = chronologically
  const results: AuditEntry[] = [];
  for (const file of sorted) {
    const entries = await readEntriesFromFile(join(archiveDir, file));
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

  // let — writer and size tracking are replaced on each rotation
  let writer = Bun.file(config.filePath).writer();
  let bytesWritten = 0;
  let currentDay = config._clockForTesting?.todayUtc() ?? defaultTodayUtc();

  // Single-writer queue: all log()/flush()/close() calls are chained so rotation
  // is never re-entered concurrently and writes never race across a rotate boundary.
  // Seed bytesWritten and, for daily rotation, currentDay from the active file's
  // on-disk stat so a restarted process handles pre-existing files correctly.
  let writeChain: Promise<void> = stat(config.filePath)
    .then((s) => {
      bytesWritten = s.size;
      if (config.rotation?.daily === true && s.size > 0) {
        // Initialize currentDay from the file's mtime so a restart against a
        // previous-day file triggers rotation on the first new-day write.
        currentDay = new Date(s.mtimeMs).toISOString().slice(0, 10);
      }
    })
    .catch(() => {
      /* ENOENT or unreadable — keep counter at 0 and currentDay as today */
    });

  const timer = setInterval(() => {
    // Route through the write chain so the timer flush doesn't race rotation or close.
    writeChain = writeChain.then(() => writer.flush()).catch(() => {});
  }, flushIntervalMs);

  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  async function rotate(): Promise<void> {
    await writer.flush();

    await mkdir(archiveDir, { recursive: true });

    const ts = rotationTimestamp();
    const archivePath = join(archiveDir, `${ts}.ndjson`);
    // End the writer only after the archive directory is ready. If rename() fails,
    // the writer has already ended but we reopen the original file so subsequent
    // log() calls still persist rather than silently dropping entries.
    await writer.end();
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
        await rotateIfNeeded(lineBytes);
        writer.write(line);
        bytesWritten += lineBytes;
      });
    },

    flush(): Promise<void> {
      return enqueue(() => writer.flush());
    },

    getEntries(): Promise<readonly AuditEntry[]> {
      // Serialized through the write queue so a concurrent rotation cannot move
      // a file out of the active path after we snapshot the archive directory.
      let result: readonly AuditEntry[] = [];
      return enqueue(async () => {
        await writer.flush();
        const archived = await readArchiveEntries(archiveDir);
        const current = await readEntriesFromFile(config.filePath);
        result = [...archived, ...current];
      }).then(() => result);
    },

    async query(sessionId: string): Promise<readonly AuditEntry[]> {
      const all = await this.getEntries();
      return all.filter((e) => e.sessionId === sessionId);
    },

    close(): Promise<void> {
      return enqueue(async () => {
        clearInterval(timer);
        await writer.flush();
        await writer.end();
      });
    },
  };
}
