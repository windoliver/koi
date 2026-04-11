/**
 * Buffered NDJSON file sink — one JSON object per line.
 *
 * Uses a Bun write stream opened once at creation, buffering lines in memory
 * and flushing on a configurable interval. No appendFile() syscall per record.
 * Redaction is the middleware's responsibility — this sink writes what it receives.
 */

import { readFile } from "node:fs/promises";
import type { AuditEntry, AuditSink } from "@koi/core";
import type { NdjsonAuditSinkConfig } from "./config.js";

const DEFAULT_FLUSH_INTERVAL_MS = 2000;

export function createNdjsonAuditSink(config: NdjsonAuditSinkConfig): AuditSink & {
  /** Read all entries from the file (for testing). */
  readonly getEntries: () => Promise<readonly AuditEntry[]>;
  /** Flush buffered lines to disk. */
  readonly flush: () => Promise<void>;
  /** Flush, end the writer, and clear the flush interval. */
  readonly close: () => Promise<void>;
} {
  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

  // Open the write stream once — buffered, append-mode
  const writer = Bun.file(config.filePath).writer();

  const timer = setInterval(() => {
    void writer.flush();
  }, flushIntervalMs);

  // Prevent the timer from keeping the process alive
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }

  return {
    async log(entry: AuditEntry): Promise<void> {
      const line = `${JSON.stringify(entry)}\n`;
      writer.write(line);
      // No await — the write stream buffers internally
    },

    async flush(): Promise<void> {
      await writer.flush();
    },

    async getEntries(): Promise<readonly AuditEntry[]> {
      // Flush first to ensure all buffered lines are on disk
      await writer.flush();
      try {
        const content = await readFile(config.filePath, "utf-8");
        const entries: AuditEntry[] = [];
        const lines = content.split("\n").filter((l) => l.trim().length > 0);
        let lineNum = 0;
        for (const line of lines) {
          lineNum++;
          try {
            entries.push(JSON.parse(line.trim()) as AuditEntry);
          } catch {
            // Any parse failure is surfaced as an error — silently dropping records
            // would hide corruption or tampering from compliance consumers.
            throw new Error(
              `Audit log corrupted: line ${lineNum} failed to parse in ${config.filePath}`,
            );
          }
        }
        return entries;
      } catch (e: unknown) {
        if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw e;
      }
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
