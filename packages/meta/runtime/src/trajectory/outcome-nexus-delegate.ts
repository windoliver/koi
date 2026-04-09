/**
 * Nexus-backed OutcomeStore delegate.
 * Stores each outcome report as `{basePath}/{correlationId}.json` on a Nexus server.
 *
 * Design constraints (Phase 1):
 *   - **put + get only** — enumeration and deletion deferred until consumer exists
 *   - Rate-limit retry with exponential backoff on write
 *   - NOT_FOUND maps to undefined on get; auth/permission errors propagate
 *   - Shares NexusTransport with trajectory delegate (same connection)
 */

import type { KoiError, OutcomeReport, OutcomeStore, Result } from "@koi/core";
import type { NexusTransport } from "@koi/fs-nexus";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusOutcomeConfig {
  /** Nexus transport (from createHttpTransport or createLocalTransport). */
  readonly transport: NexusTransport;
  /** Nexus path prefix for outcome documents. Default: "outcomes". */
  readonly basePath?: string | undefined;
}

const DEFAULT_BASE_PATH = "outcomes";
const WRITE_MAX_RETRIES = 4;
const WRITE_BACKOFF_BASE_MS = 2000;

// ---------------------------------------------------------------------------
// basePath validation
// ---------------------------------------------------------------------------

function validateBasePath(basePath: string): void {
  if (basePath === "") {
    throw new Error("outcomeNexus.basePath must not be empty");
  }
  if (basePath.includes("..")) {
    throw new Error("outcomeNexus.basePath must not contain '..' segments");
  }
  if (basePath.endsWith("/")) {
    throw new Error("outcomeNexus.basePath must not end with '/'");
  }
}

// ---------------------------------------------------------------------------
// Nexus response decoding
// ---------------------------------------------------------------------------

/**
 * Decode a Nexus read response. Nexus may return:
 *   - A raw JSON string
 *   - A bytes envelope: { __type__: "bytes", data: "base64..." }
 *   - A structured envelope: { content: string, metadata?: ... }
 *   - An already-parsed object
 */
function decodeNexusResponse<T>(raw: unknown): T {
  if (typeof raw === "string") return JSON.parse(raw) as T;
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    // Bytes envelope (Nexus NFS binary response)
    if (obj.__type__ === "bytes" && typeof obj.data === "string") {
      const decoded = Buffer.from(obj.data, "base64").toString("utf-8");
      return JSON.parse(decoded) as T;
    }
    // Structured envelope { content: string, metadata? } from Nexus read
    if (typeof obj.content === "string" && !("correlationId" in obj)) {
      return JSON.parse(obj.content) as T;
    }
  }
  return raw as T;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a Nexus-backed outcome store for decision-outcome correlation (#1465). */
export function createNexusOutcomeDelegate(config: NexusOutcomeConfig): OutcomeStore {
  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  validateBasePath(basePath);

  const { transport } = config;

  // Nexus NFS expects absolute paths with leading slash
  const normalizedBase = basePath.startsWith("/") ? basePath : `/${basePath}`;

  /** Validate correlation ID: non-empty, bounded, no path traversal. */
  function validateCorrelationId(correlationId: string): void {
    if (typeof correlationId !== "string" || correlationId.trim().length === 0) {
      throw new Error("outcomeStore: correlationId must be a non-empty string");
    }
    if (correlationId.length > 256) {
      throw new Error("outcomeStore: correlationId exceeds 256 character limit");
    }
  }

  function outcomePath(correlationId: string): string {
    // Encode correlation ID for safe filesystem use
    const encoded = encodeURIComponent(correlationId);
    return `${normalizedBase}/${encoded}.json`;
  }

  /** Throw a KoiError as an Error with the original attached as cause. */
  function throwKoiError(err: KoiError): never {
    throw new Error(err.message, { cause: err });
  }

  return {
    async put(report: OutcomeReport): Promise<void> {
      validateCorrelationId(report.correlationId);
      const content = JSON.stringify(report);
      const path = outcomePath(report.correlationId);

      // Overwrite semantics: last write wins, matching the OutcomeStore contract
      // and the in-memory implementation. Atomic create/OCC (etag/if_match) is
      // deferred to Phase 2 when Nexus adds server-side conditional writes (#1465).
      for (let attempt = 0; attempt <= WRITE_MAX_RETRIES; attempt++) {
        const result: Result<unknown, KoiError> = await transport.call("write", {
          path,
          content,
        });
        if (result.ok) return;

        const isRateLimit = result.error.code === "RATE_LIMIT";
        if (attempt < WRITE_MAX_RETRIES && isRateLimit) {
          // Exponential backoff: 2s, 4s, 8s, 16s
          await new Promise<void>((resolve) =>
            setTimeout(resolve, WRITE_BACKOFF_BASE_MS * 2 ** attempt),
          );
          continue;
        }
        throwKoiError(result.error);
      }
    },

    async get(correlationId: string): Promise<OutcomeReport | undefined> {
      validateCorrelationId(correlationId);
      const result: Result<unknown, KoiError> = await transport.call("read", {
        path: outcomePath(correlationId),
      });
      if (!result.ok) {
        if (result.error.code === "NOT_FOUND") return undefined;
        throwKoiError(result.error);
      }
      const report = decodeNexusResponse<OutcomeReport>(result.value);
      // Verify decoded report matches requested ID (fail closed on mismatch)
      if (report.correlationId !== correlationId) {
        throw new Error(
          `outcomeStore: stored report correlationId "${String(report.correlationId)}" does not match requested "${correlationId}"`,
        );
      }
      return report;
    },
  };
}
