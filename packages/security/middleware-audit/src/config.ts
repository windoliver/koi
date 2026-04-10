/**
 * Configuration for @koi/middleware-audit.
 */

import type { AuditEntry, AuditSink } from "@koi/core";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { RedactionConfig } from "@koi/redaction";

export interface AuditMiddlewareConfig {
  readonly sink: AuditSink;
  /** Passed to createRedactor(). Defaults to no redaction patterns. */
  readonly redaction?: Partial<RedactionConfig>;
  /** When true, request bodies are replaced with "[redacted]" before writing. */
  readonly redactRequestBodies?: boolean;
  /** Maximum serialized entry size in characters before truncation. Default: 10_000. */
  readonly maxEntrySize?: number;
  /** Maximum entries in the backpressure queue before overflow. Default: 1000. */
  readonly maxQueueDepth?: number;
  /** Called when an entry is dropped due to queue overflow. */
  readonly onOverflow?: (entry: AuditEntry, droppedCount: number) => void;
  /** Called when the sink rejects an entry. Defaults to swallowError. */
  readonly onError?: (error: unknown, entry: AuditEntry) => void;
  /**
   * Enable tamper-evident signing.
   * - true: generate an ephemeral Ed25519 keypair at startup
   * - { privateKey: CryptoKey }: use the provided key
   * - false/undefined: no signing or hash chain
   */
  readonly signing?: boolean | { readonly privateKey: CryptoKey };
}

function fail(message: string): Result<never, KoiError> {
  return {
    ok: false,
    error: { code: "VALIDATION", message, retryable: RETRYABLE_DEFAULTS.VALIDATION },
  };
}

export function validateAuditConfig(config: unknown): Result<AuditMiddlewareConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return fail("config must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  if (c.sink === null || c.sink === undefined || typeof c.sink !== "object") {
    return fail("config.sink is required and must be an object");
  }
  const sink = c.sink as Record<string, unknown>;
  if (typeof sink.log !== "function") {
    return fail("config.sink.log must be a function");
  }

  if (c.maxEntrySize !== undefined) {
    if (typeof c.maxEntrySize !== "number" || c.maxEntrySize <= 0) {
      return fail("config.maxEntrySize must be a positive number");
    }
  }

  if (c.maxQueueDepth !== undefined) {
    if (typeof c.maxQueueDepth !== "number" || c.maxQueueDepth <= 0) {
      return fail("config.maxQueueDepth must be a positive number");
    }
  }

  if (c.onOverflow !== undefined && typeof c.onOverflow !== "function") {
    return fail("config.onOverflow must be a function");
  }

  if (c.onError !== undefined && typeof c.onError !== "function") {
    return fail("config.onError must be a function");
  }

  if (c.signing !== undefined && typeof c.signing !== "boolean") {
    if (typeof c.signing !== "object" || c.signing === null) {
      return fail("config.signing must be a boolean or { privateKey: CryptoKey }");
    }
    const signing = c.signing as Record<string, unknown>;
    if (signing.privateKey === undefined) {
      return fail("config.signing.privateKey is required when signing is an object");
    }
  }

  return { ok: true, value: config as AuditMiddlewareConfig };
}
