/**
 * NDJSON file audit sink — one JSON object per line.
 *
 * Simple alternative to SQLite for quick local dev and log shipping.
 */

import { appendFile, readFile } from "node:fs/promises";
import type { AuditEntry, AuditSink, RedactionRule } from "@koi/core";
import type { NdjsonAuditSinkConfig } from "./types.js";

/** Apply redaction rules to a serialized string. */
function applyRedaction(text: string, rules: readonly RedactionRule[]): string {
  // let justified: iteratively applying regex replacements requires mutation
  let result = text;
  for (const rule of rules) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

/**
 * Create an NDJSON file audit sink.
 *
 * Each entry is serialized as a single line of JSON and appended to the file.
 */
export function createNdjsonAuditSink(config: NdjsonAuditSinkConfig): AuditSink & {
  /** Read all entries from the file (for testing). */
  readonly getEntries: () => Promise<readonly AuditEntry[]>;
  /** Close the sink (no-op for file-based). */
  readonly close: () => void;
} {
  const redactionRules = config.redactionRules ?? [];

  return {
    async log(entry: AuditEntry): Promise<void> {
      const json = JSON.stringify(entry);
      const line = redactionRules.length > 0 ? applyRedaction(json, redactionRules) : json;
      await appendFile(config.filePath, `${line}\n`, "utf-8");
    },

    async flush(): Promise<void> {
      // No buffering — each log call writes immediately
    },

    async getEntries(): Promise<readonly AuditEntry[]> {
      try {
        const content = await readFile(config.filePath, "utf-8");
        return content
          .trim()
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as AuditEntry);
      } catch (e: unknown) {
        if (e instanceof Error && "code" in e && e.code === "ENOENT") {
          return [];
        }
        throw e;
      }
    },

    async query(sessionId: string): Promise<readonly AuditEntry[]> {
      const all = await this.getEntries();
      return all.filter((e) => e.sessionId === sessionId);
    },

    close(): void {
      // No resources to clean up for file-based sink
    },
  };
}
