/**
 * Type contracts for the koi-owned Durable Object (`KoiDedupeDO`).
 *
 * The DO is what makes the dedupe protocol durable — every claim/complete/fail
 * call serialises through one DO instance keyed by `${ownerId}:${operationId}`,
 * giving us linearisable single-key consistency.
 *
 * These types describe the wire shape the DO accepts on each path. The DO
 * itself lives in `dedupe-do-class.ts`; mock storage for tests lives in
 * `dedupe-do-mock-storage.ts`.
 */

export interface ClaimRequest {
  readonly operationId: string;
  readonly requestId: string;
  readonly dedupeFingerprint: string;
  readonly dedupeExpiresAtMs: number;
}

export type ClaimStatus =
  | { readonly status: "fresh" }
  | { readonly status: "in-progress"; readonly claimer: string; readonly leaseUntil: number }
  | { readonly status: "completed"; readonly result: unknown; readonly statusCode: number }
  | { readonly status: "failed-permanent"; readonly error: unknown }
  | { readonly status: "fingerprint-conflict"; readonly storedFingerprint: string }
  | { readonly status: "operation-expired"; readonly originalDedupeExpiresAtMs: number };

export interface CompleteRequest {
  readonly operationId: string;
  readonly requestId: string;
  readonly dedupeFingerprint: string;
  readonly result: unknown;
  readonly statusCode: number;
  readonly ttlExpiresAtMs: number;
}

export interface FailRequest {
  readonly operationId: string;
  readonly requestId: string;
  readonly dedupeFingerprint: string;
  readonly error: unknown;
  readonly ttlExpiresAtMs: number;
}

export interface WaitForTerminalRequest {
  readonly operationId: string;
  readonly requestId: string;
  /**
   * Caller-supplied expiry, used ONLY for mismatch detection against the
   * stored ledger value. Never used to authorise the wait deadline — that
   * comes from the ledger row.
   */
  readonly requestExpiryClaim: number;
  readonly timeoutMs: number;
  /**
   * Optional poll interval override (ms). Tests use small values; production
   * defaults to 1000ms per spec.
   */
  readonly pollIntervalMs?: number;
}

export type WaitOutcome =
  | { readonly kind: "completed"; readonly result: unknown }
  | { readonly kind: "failed-permanent"; readonly error: unknown }
  | { readonly kind: "operation-expired"; readonly originalDedupeExpiresAtMs: number }
  | { readonly kind: "operation-id-conflict"; readonly storedFingerprint: string }
  | { readonly kind: "timeout" };

/** Stored ledger row — write-once at first claim, immutable thereafter. */
export interface LedgerRow {
  readonly firstClaimAtMs: number;
  readonly originalDedupeExpiresAtMs: number;
  readonly originalDedupeFingerprint: string;
  readonly ledgerExpiresAtMs: number;
}

/** Stored claim record — exists while an isolate holds the lease. */
export interface ClaimRecord {
  readonly claimer: string;
  readonly claimedAt: number;
  readonly leaseUntil: number;
  readonly dedupeFingerprint: string;
}

/** Stored terminal record — present after `complete` or `fail`. */
export type TerminalRecord =
  | {
      readonly kind: "completed";
      readonly result: unknown;
      readonly statusCode: number;
      readonly completedAt: number;
      readonly ttlExpiresAt: number;
      readonly dedupeFingerprint: string;
    }
  | {
      readonly kind: "failed-permanent";
      readonly error: unknown;
      readonly failedAt: number;
      readonly ttlExpiresAt: number;
      readonly dedupeFingerprint: string;
    };

/**
 * Minimal subset of the Cloudflare `DurableObjectStorage` we depend on,
 * narrowed so tests can stub it with an in-memory Map. Production uses the
 * real DO storage; tests use `dedupe-do-mock-storage.ts`.
 */
export interface DedupeDoStorage {
  readonly get: <T>(key: string) => Promise<T | undefined>;
  readonly put: (entries: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly delete: (keys: readonly string[]) => Promise<number>;
  readonly list: (options?: { readonly prefix?: string }) => Promise<ReadonlyMap<string, unknown>>;
  readonly setAlarm: (whenMs: number) => Promise<void>;
  readonly getAlarm: () => Promise<number | null>;
  readonly transaction: <T>(fn: (txn: DedupeDoStorage) => Promise<T>) => Promise<T>;
}

/** Clock injection — tests replace `Date.now`. */
export interface DedupeDoClock {
  readonly nowMs: () => number;
}

export interface DedupeDoConfig {
  /** Lease duration (ms) — spec default 15_000. */
  readonly leaseDurationMs?: number;
  /** Skew tolerance for `dedupeExpiresAtMs` mismatch (ms) — spec default 1000. */
  readonly skewToleranceMs?: number;
  /** Hard cap on `dedupeExpiresAtMs` from now (ms) — spec default 30 days. */
  readonly maxDedupeHorizonMs?: number;
  /** Result-record retention beyond `dedupeExpiresAtMs` (ms) — spec default 1h. */
  readonly resultGraceMs?: number;
}
