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

import { mkdir, readdir, readFile, rename } from "node:fs/promises";
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

  const timer = setInterval(() => {
    void writer.flush();
  }, flushIntervalMs);

  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  async function rotate(): Promise<void> {
    await writer.flush();
    await writer.end();

    await mkdir(archiveDir, { recursive: true });

    const ts = rotationTimestamp();
    const archivePath = join(archiveDir, `${ts}.ndjson`);
    await rename(config.filePath, archivePath);

    writer = Bun.file(config.filePath).writer();
    bytesWritten = 0;
    currentDay = config._clockForTesting?.todayUtc() ?? defaultTodayUtc();
  }

  async function rotateIfNeeded(): Promise<void> {
    if (!config.rotation) return;

    const today = config._clockForTesting?.todayUtc() ?? defaultTodayUtc();
    const bySize =
      config.rotation.maxSizeBytes !== undefined &&
      bytesWritten > 0 &&
      bytesWritten >= config.rotation.maxSizeBytes;
    const byDay = config.rotation.daily === true && today !== currentDay;

    if (bySize || byDay) {
      await rotate();
    }
  }

  return {
    async log(entry: AuditEntry): Promise<void> {
      await rotateIfNeeded();
      const line = `${JSON.stringify(entry)}\n`;
      writer.write(line);
      bytesWritten += line.length;
    },

    async flush(): Promise<void> {
      await writer.flush();
    },

    async getEntries(): Promise<readonly AuditEntry[]> {
      await writer.flush();
      const archived = await readArchiveEntries(archiveDir);
      const current = await readEntriesFromFile(config.filePath);
      return [...archived, ...current];
    },

    async query(sessionId: string): Promise<readonly AuditEntry[]> {
      const all = await this.getEntries();
      return all.filter((e) => e.sessionId === sessionId);
    },

    async close(): Promise<void> {
      clearInterval(timer);
      await writer.flush();
      await writer.end();
    },
  };
}
