/**
 * Audit backend — structured audit logging contract (Layer 0).
 *
 * Defines the shape of audit entries, sinks, and redaction rules.
 * L2 packages implement AuditSink for specific backends (console, Nexus, etc.).
 */

import type { JsonObject } from "./common.js";

export interface AuditEntry {
  readonly timestamp: number;
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly kind: "model_call" | "tool_call" | "session_start" | "session_end" | "secret_access";
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
