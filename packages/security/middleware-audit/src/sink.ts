/**
 * Audit sink default implementations and utilities.
 *
 * Types (AuditEntry, AuditSink, RedactionRule) are defined in @koi/core.
 */

import type { AuditEntry, AuditSink, RedactionRule } from "@koi/core";

// Re-export L0 types for backwards compatibility
export type { AuditEntry, AuditSink, RedactionRule } from "@koi/core";

/**
 * In-memory audit sink. Stores entries in an array for testing/dev.
 *
 * @deprecated Use `createSqliteAuditSink` or `createNdjsonAuditSink` from
 * `@koi/audit-sink-local` instead. They provide batched inserts, redaction,
 * and persistent storage.
 */
export function createInMemoryAuditSink(): AuditSink & {
  readonly entries: readonly AuditEntry[];
} {
  const entries: AuditEntry[] = [];

  return {
    get entries(): readonly AuditEntry[] {
      return entries;
    },

    async log(entry: AuditEntry): Promise<void> {
      entries.push(entry);
    },

    async flush(): Promise<void> {
      // No-op for in-memory sink — all entries are immediately available
    },

    async query(sessionId: string): Promise<readonly AuditEntry[]> {
      return entries.filter((e) => e.sessionId === sessionId);
    },
  };
}

/**
 * Console audit sink. Outputs structured JSON to stdout.
 */
export function createConsoleAuditSink(): AuditSink {
  return {
    async log(entry: AuditEntry): Promise<void> {
      console.log(JSON.stringify(entry));
    },
  };
}

/**
 * Apply redaction rules to a serialized string.
 */
export function applyRedaction(text: string, rules: readonly RedactionRule[]): string {
  let result = text;
  for (const rule of rules) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

/**
 * Truncate a string to a maximum length.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...[truncated]`;
}
