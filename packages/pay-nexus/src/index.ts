/**
 * @koi/pay-nexus — Nexus-backed credit ledger (Layer 2)
 *
 * Persistent PayLedger implementation that talks to the Nexus pay API
 * (TigerBeetle + PostgreSQL). Includes a BudgetTracker adapter for
 * drop-in compatibility with @koi/middleware-pay.
 */

export { createNexusBudgetTracker, mapPayLedgerToBudgetTracker } from "./adapter.js";
export type { NexusPayLedgerConfig } from "./config.js";
export { validatePayLedgerConfig } from "./config.js";
export { payNexusDescriptor } from "./descriptor.js";
export { createNexusPayLedger } from "./ledger.js";
