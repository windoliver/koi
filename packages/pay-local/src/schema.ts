/**
 * SQLite schema and prepared statements for the local pay ledger.
 * Only used when a dbPath is provided.
 */

import type { Database } from "bun:sqlite";

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS ledger_entries (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    amount TEXT NOT NULL,
    balance_after TEXT NOT NULL,
    reservation_id TEXT,
    counterparty TEXT,
    memo TEXT,
    timestamp TEXT NOT NULL
  )
`;

/** Initialize the ledger schema on the given database. */
export function initSchema(db: Database): void {
  db.run(CREATE_TABLE);
}

/** Insert a ledger entry using a prepared statement. */
export function insertEntry(
  db: Database,
  entry: {
    readonly id: string;
    readonly kind: string;
    readonly amount: string;
    readonly balanceAfter: string;
    readonly reservationId: string | null;
    readonly counterparty: string | null;
    readonly memo: string | null;
    readonly timestamp: string;
  },
): void {
  const stmt = db.prepare(
    `INSERT INTO ledger_entries (id, kind, amount, balance_after, reservation_id, counterparty, memo, timestamp)
     VALUES ($id, $kind, $amount, $balanceAfter, $reservationId, $counterparty, $memo, $timestamp)`,
  );
  stmt.run({
    $id: entry.id,
    $kind: entry.kind,
    $amount: entry.amount,
    $balanceAfter: entry.balanceAfter,
    $reservationId: entry.reservationId,
    $counterparty: entry.counterparty,
    $memo: entry.memo,
    $timestamp: entry.timestamp,
  });
}

/** Read all ledger entries from the database ordered by rowid. */
export function readAllEntries(db: Database): readonly {
  readonly id: string;
  readonly kind: string;
  readonly amount: string;
  readonly balance_after: string;
  readonly reservation_id: string | null;
  readonly counterparty: string | null;
  readonly memo: string | null;
  readonly timestamp: string;
}[] {
  return db.prepare("SELECT * FROM ledger_entries ORDER BY rowid ASC").all() as readonly {
    readonly id: string;
    readonly kind: string;
    readonly amount: string;
    readonly balance_after: string;
    readonly reservation_id: string | null;
    readonly counterparty: string | null;
    readonly memo: string | null;
    readonly timestamp: string;
  }[];
}
