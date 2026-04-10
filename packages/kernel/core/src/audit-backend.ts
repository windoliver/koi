/**
 * Audit backend — structured audit logging contract (Layer 0).
 *
 * Defines the shape of audit entries, sinks, and redaction rules.
 * L2 packages implement AuditSink for specific backends (console, Nexus, etc.).
 */

import type { JsonObject } from "./common.js";

export interface AuditEntry {
  /** Schema version — increment when the shape changes. Readers gate on this field. */
  readonly schema_version: number;
  readonly timestamp: number;
  readonly sessionId: string;
  readonly agentId: string;
  readonly turnIndex: number;
  readonly kind:
    | "model_call"
    | "tool_call"
    | "session_start"
    | "session_end"
    | "secret_access"
    | "permission_decision"
    | "config_change";
  readonly request?: unknown;
  readonly response?: unknown;
  readonly error?: unknown;
  readonly durationMs: number;
  readonly metadata?: JsonObject;
  /** SHA-256 hex of the previous entry's canonical JSON. Genesis entry uses 64 zero chars. */
  readonly prev_hash?: string;
  /** Base64url Ed25519 signature over the entry (excluding this field). */
  readonly signature?: string;
}

export interface AuditSink {
  readonly log: (entry: AuditEntry) => Promise<void>;
  readonly flush?: () => Promise<void>;
  /** Query audit entries for a session. Optional — enables rich trajectory adapters. */
  readonly query?: (sessionId: string) => Promise<readonly AuditEntry[]>;
}

export interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}
