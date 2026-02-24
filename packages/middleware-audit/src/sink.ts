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
