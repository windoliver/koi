/**
 * Audit sink interfaces and default implementations.
 */

import type { JsonObject } from "@koi/core/common";

export interface AuditEntry {
  readonly timestamp: number;
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly kind: "model_call" | "tool_call" | "session_start" | "session_end";
  readonly request?: unknown;
  readonly response?: unknown;
  readonly error?: unknown;
  readonly durationMs: number;
  readonly metadata?: JsonObject;
}

export interface AuditSink {
  readonly log: (entry: AuditEntry) => Promise<void>;
  readonly flush?: () => Promise<void>;
}

export interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

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
