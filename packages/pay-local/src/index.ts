/**
 * @koi/pay-local — Local PayLedger implementation (Layer 2).
 *
 * Provides a fully-functional PayLedger backed by an append-only in-memory
 * ledger with optional SQLite persistence.
 */

export { createLocalPayLedger } from "./ledger.js";
export type { LocalPayLedgerConfig } from "./types.js";
