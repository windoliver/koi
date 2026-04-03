/**
 * Configuration and internal types for the local pay ledger.
 */

/** Configuration for createLocalPayLedger. */
export interface LocalPayLedgerConfig {
  /** Initial budget in decimal string (e.g., "1000"). */
  readonly initialBudget: string;
  /** Agent identifier for this ledger. */
  readonly agentId: string;
  /** SQLite database path. Omit or use ":memory:" for in-memory. */
  readonly dbPath?: string | undefined;
  /** Number of entries before compaction collapses history. Default: 1000. */
  readonly compactionThreshold?: number | undefined;
}

/** Internal ledger entry kinds. */
export type LedgerEntryKind =
  | "credit"
  | "debit"
  | "reserve"
  | "commit"
  | "release"
  | "transfer"
  | "meter";

/** An append-only ledger entry. */
export interface LedgerEntry {
  readonly id: string;
  readonly kind: LedgerEntryKind;
  readonly amount: string;
  readonly balanceAfter: string;
  readonly reservationId: string | null;
  readonly counterparty: string | null;
  readonly memo: string | null;
  readonly timestamp: string;
}

/** Internal reservation state. */
export interface ReservationState {
  readonly id: string;
  readonly amount: number;
  readonly purpose: string;
  readonly expiresAt: number | null;
  readonly timerId: ReturnType<typeof setTimeout> | null;
}
